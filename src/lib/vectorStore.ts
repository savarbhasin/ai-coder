import chokidar from 'chokidar';
import { FSWatcher } from 'chokidar';
import { CodeSplitter } from "llamaindex";
import Parser from "tree-sitter";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import * as fs from "fs/promises";
import * as path from "path";
import { CODE_BASE_PATH, EMBEDDING_MODEL, MAX_CHARS, VECTOR_STORE_PATH } from "../config";

const TypeScript = require("tree-sitter-typescript").typescript;
const JavaScript = require("tree-sitter-javascript");

interface FileIndex {
    [filePath: string]: number; // filePath -> lastIndexed timestamp
}

export class IncrementalVectorStore {
    private vectorStore: FaissStore | null = null;
    private embeddings: OpenAIEmbeddings;
    private parser: Parser;
    private splitter: CodeSplitter;
    private fileIndex: FileIndex = {};
    private indexPath: string;
    private watcher: FSWatcher | null = null;

    constructor() {
        this.embeddings = new OpenAIEmbeddings({
            model: EMBEDDING_MODEL,
        });

        // Initialize parser
        this.parser = new Parser();
        this.parser.setLanguage(TypeScript);

        // Initialize splitter
        this.splitter = new CodeSplitter({
            maxChars: MAX_CHARS,
            getParser: () => this.parser
        });

        this.indexPath = path.join(VECTOR_STORE_PATH, 'file_index.json');
    }

    async initialize(): Promise<void> {
        try {
            this.vectorStore = await FaissStore.load(VECTOR_STORE_PATH, this.embeddings);
            await this.loadFileIndex();
            await this.syncMissedChanges();
        } catch (error) {
            console.log("error loading vector store", error);
        }
    }

    private async loadFileIndex(): Promise<void> {
        try {
            const indexData = await fs.readFile(this.indexPath, 'utf-8');
            this.fileIndex = JSON.parse(indexData);
        } catch (error) {
            console.log("error loading file index", error);
            this.fileIndex = {};
        }
    }

    private async saveFileIndex(): Promise<void> {
        await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
        await fs.writeFile(this.indexPath, JSON.stringify(this.fileIndex, null, 2));
    }



    private async syncMissedChanges(sourceDir: string = CODE_BASE_PATH): Promise<void> {
        const changedFiles: string[] = [];
        const newFiles: string[] = [];

        const checkDirectory = async (dirPath: string): Promise<void> => {
            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    
                    if (entry.isDirectory()) {
                        if (!["node_modules", ".git", "dist", "build"].includes(entry.name)) {
                            await checkDirectory(fullPath);
                        }
                    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                        const relativePath = path.relative(process.cwd(), fullPath);
                        const stats = await fs.stat(fullPath);
                        const fileModifiedTime = stats.mtime.getTime();
                        
                        const lastIndexed = this.fileIndex[relativePath];
                        
                        if (!lastIndexed) {
                            // New file not in index
                            newFiles.push(fullPath);
                        } else if (fileModifiedTime > lastIndexed) {
                            // File modified since last indexing
                            changedFiles.push(fullPath);
                        }
                    }
                }
            } catch (error) {
                console.error(`error checking directory ${dirPath}:`, error);
            }
        };

        await checkDirectory(sourceDir);

        const totalChanges = changedFiles.length + newFiles.length;
        
        if (totalChanges > 0) {
            console.log(`found ${changedFiles.length} changed files and ${newFiles.length} new files, updating...`);
            
            // Update changed files
            for (const filePath of changedFiles) {
                await this.updateFile(filePath);
            }
            
            // Add new files
            for (const filePath of newFiles) {
                await this.updateFile(filePath);
            }
            
            console.log("finished syncing missed changes");
        } else {
            console.log("no files changed while offline");
        }
    }

    async processFile(filePath: string): Promise<Document[]> {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const relativePath = path.relative(process.cwd(), filePath);
            
            if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
                this.parser.setLanguage(JavaScript);
            } else {
                this.parser.setLanguage(TypeScript);
            }
            
            const chunks = this.splitter.splitText(content);
            
            const documents: Document[] = [];
            
            chunks.forEach((chunk, index) => {
                const lines = content.substring(0, content.indexOf(chunk)).split('\n').length;
                const endLines = lines + chunk.split('\n').length - 1;
                
                documents.push(new Document({
                    pageContent: chunk,
                    metadata: {
                        filePath: relativePath,
                        startLine: lines,
                        endLine: endLines,
                        type: this.getChunkType(chunk),
                        length: chunk.length
                    }
                }));
            });
            
            return documents;
        } catch (error) {
            console.error(`error processing file ${filePath}:`, error);
            return [];
        }
    }

    private getChunkType(chunk: string): string {
        if (chunk.includes('function ') || chunk.includes('const ') && chunk.includes('=>')) {
            return 'function';
        } else if (chunk.includes('class ')) {
            return 'class';
        } else if (chunk.includes('interface ') || chunk.includes('type ')) {
            return 'type';
        } else if (chunk.includes('import ') || chunk.includes('export ')) {
            return 'import_export';
        }
        return 'other';
    }

    async updateFile(filePath: string): Promise<void> {
        const relativePath = path.relative(process.cwd(), filePath);

        try {
            // Step 1: Remove existing vectors for this file (if any)
            await this.removeFileFromIndex(relativePath);

            // Step 2: Process the updated file
            const newDocuments = await this.processFile(filePath);
            
            if (newDocuments.length === 0) {
                delete this.fileIndex[relativePath]; // Remove from index if no chunks
                await this.saveFileIndex();
                return;
            }

            // Step 3: Add new vectors (only embeds these documents!)
            if (!this.vectorStore) {
                // Create initial vector store
                this.vectorStore = await FaissStore.fromDocuments(newDocuments, this.embeddings);
                await fs.mkdir(VECTOR_STORE_PATH, { recursive: true });
            } else {
                // Add to existing store - only computes embeddings for new docs
                await this.vectorStore.addDocuments(newDocuments);
            }

            // Step 4: Update file index with current timestamp
            this.fileIndex[relativePath] = Date.now();

            // Step 5: Save everything
            await this.vectorStore.save(VECTOR_STORE_PATH);
            await this.saveFileIndex();


        } catch (error) {
            console.error(`error updating ${relativePath}:`, error);
        }
    }

    async removeFileFromIndex(filePath: string): Promise<void> {
        const relativePath = path.relative(process.cwd(), filePath);
        
        if (!this.fileIndex[relativePath] || !this.vectorStore) {
            return; 
        }
  
        try {
            this.vectorStore.delete({ids: [relativePath]})
        } catch (error) {
            console.warn(`could not cleanly remove vectors for ${relativePath}, will be overwritten:`, error);
        }

        delete this.fileIndex[relativePath];
    }

    async deleteFile(filePath: string): Promise<void> {
        const relativePath = path.relative(process.cwd(), filePath);
        
        await this.removeFileFromIndex(relativePath);
        await this.saveFileIndex();
        
        if (this.vectorStore) {
            await this.vectorStore.save(VECTOR_STORE_PATH);
        }
    }

    startWatching(sourceDir: string = CODE_BASE_PATH): void {
        if (this.watcher) {
            this.watcher.close();
        }

        const watchPattern = path.join(sourceDir, '**/*.{ts,tsx,js,jsx}');

        this.watcher = chokidar.watch(watchPattern, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**'
            ],
            persistent: true,
            ignoreInitial: true 
        });

        this.watcher
            .on('change', (filePath: string) => {
                console.log(`file changed: ${filePath}`);
                this.updateFile(filePath);
            })
            .on('add', (filePath: string) => {
                console.log(`file added: ${filePath}`);
                this.updateFile(filePath);
            })
            .on('unlink', (filePath: string) => {
                console.log(`file deleted: ${filePath}`);
                this.removeFileFromIndex(filePath);
            })
            .on('error', (error: unknown) => console.error(`watcher error`));
    }

    stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            console.log("stopped watching files");
        }
    }

    getVectorStore(): FaissStore | null {
        return this.vectorStore;
    }

    async rebuildIndex(sourceDir: string = CODE_BASE_PATH): Promise<void> {
        console.log("rebuilding entire index...");
        
        const allDocuments: Document[] = [];
        this.fileIndex = {};

        const processDirectory = async (dirPath: string) => {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    if (!["node_modules", ".git", "dist", "build"].includes(entry.name)) {
                        await processDirectory(fullPath);
                    }
                } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                    const docs = await this.processFile(fullPath);
                    const relativePath = path.relative(process.cwd(), fullPath);
                    
                    if (docs.length > 0) {
                        allDocuments.push(...docs);
                        this.fileIndex[relativePath] = Date.now();
                    }
                }
            }
        };

        await processDirectory(sourceDir);
        
        console.log(`found ${allDocuments.length} documents to index`);
        
        if (allDocuments.length > 0) {
            this.vectorStore = await FaissStore.fromDocuments(allDocuments, this.embeddings);
        } else {
            this.vectorStore = null;
        }
        
        await fs.mkdir(VECTOR_STORE_PATH, { recursive: true });
        if (this.vectorStore) {
            await this.vectorStore.save(VECTOR_STORE_PATH);
        }
        await this.saveFileIndex();
        
        console.log("index rebuilt successfully");
    }
}

export const incrementalVectorStore = new IncrementalVectorStore();
