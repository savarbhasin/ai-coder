import chokidar from 'chokidar';
import { FSWatcher } from 'chokidar';
import { CodeSplitter } from "llamaindex";
import Parser from "tree-sitter";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { Index, Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import * as fs from "fs/promises";
import * as path from "path";
import { CODE_BASE_PATH, EMBEDDING_MODEL, MAX_CHARS } from "../config";
import { FileIndex } from "../types";
import dotenv from "dotenv";

const TypeScript = require("tree-sitter-typescript").typescript;
dotenv.config({quiet: true});

export class IncrementalVectorStore {
    private vectorStore: PineconeStore | null = null;
    private embeddings: OpenAIEmbeddings;
    private parser: Parser;
    private splitter: CodeSplitter;
    private fileIndex: FileIndex = {};
    private indexPath: string;
    private watcher: FSWatcher | null = null;
    private readonly codeBasePath: string;
    private pineconeIndex: Index; // Pinecone index instance

    constructor() {
        this.embeddings = new OpenAIEmbeddings({
            model: EMBEDDING_MODEL,
        });

        // parser only works for typescript currently
        this.parser = new Parser();
        this.parser.setLanguage(TypeScript);

        this.splitter = new CodeSplitter({
            maxChars: MAX_CHARS,
            getParser: () => this.parser
        });

        this.indexPath = path.join('file_index.json');
        this.codeBasePath = path.resolve(CODE_BASE_PATH);
        
        // Initialize Pinecone
        const pinecone = new PineconeClient({apiKey: process.env.PINECONE_API_KEY!});
        this.pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);
    }

    private toAbsoluteNormalized(filePath: string): string {
        const maybeAbsolute = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(this.codeBasePath, filePath);
        return maybeAbsolute.split(path.sep).join(path.posix.sep);
    }

    async initialize(): Promise<void> {
        try {
            this.vectorStore = await PineconeStore.fromExistingIndex(this.embeddings, {
                pineconeIndex: this.pineconeIndex,
                maxConcurrency: 5,
            });
            await this.loadFileIndex();
            await this.syncMissedChanges();
        } catch (error) {
            console.log("error loading vector store, creating new index...");
            // If index doesn't exist, we'll create it when adding documents
            this.vectorStore = null;
            await this.loadFileIndex();
        }
    }

    // reads the file index
    private async loadFileIndex(): Promise<void> {
        try {
            const indexData = await fs.readFile(this.indexPath, 'utf-8');
            this.fileIndex = JSON.parse(indexData);
        } catch (error) {
            console.log("error loading file index (starting fresh)");
            this.fileIndex = {};
        }
    }

    // saves the file index
    private async saveFileIndex(): Promise<void> {
        await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
        await fs.writeFile(this.indexPath, JSON.stringify(this.fileIndex, null, 2));
    }

    // Walk the codebase and detect new/changed files against absolute keys
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
                        const absolutePath = this.toAbsoluteNormalized(fullPath);
                        const stats = await fs.stat(fullPath);
                        const fileModifiedTime = stats.mtime.getTime();

                        const lastIndexed = this.fileIndex[absolutePath];

                        if (!lastIndexed) {
                            newFiles.push(absolutePath);
                        } else if (fileModifiedTime > lastIndexed.lastIndexed) {
                            changedFiles.push(absolutePath);
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
                console.log(`adding new file: ${filePath}`);
                await this.updateFile(filePath);
            }

            console.log("finished syncing missed changes");
        } else {
            console.log("no files changed while offline");
        }
    }

    async processFile(filePath: string): Promise<Document[]> {
        const absolutePath = this.toAbsoluteNormalized(filePath);

        try {
            const content = await fs.readFile(absolutePath, "utf-8");

            // Enforce TypeScript-only processing if that's desired:
            if (!(absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx'))) {
                console.log(`skipping non-typescript file ${absolutePath}`);
                return [];
            }

            const chunks = this.splitter.splitText(content);

            const documents: Document[] = [];

            chunks.forEach((chunk, index) => {
                const startIndexOfChunk = content.indexOf(chunk);
                const lines = content.substring(0, startIndexOfChunk).split('\n').length;
                const endLines = lines + chunk.split('\n').length - 1;

                documents.push(new Document({
                    pageContent: chunk,
                    metadata: {
                        filePath: absolutePath,
                        startLine: lines,
                        endLine: endLines,
                        type: this.getChunkType(chunk),
                        length: chunk.length
                    },
                    id: `${absolutePath}-${index}`
                }));
            });

            return documents;
        } catch (error) {
            console.error(`error processing file ${absolutePath}:`, error);
            return [];
        }
    }

    private getChunkType(chunk: string): string {
        // clarify precedence: treat arrow functions properly
        if (chunk.includes('function ') || (chunk.includes('const ') && chunk.includes('=>'))) {
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

    // Update file: accepts either absolute or relative path, converts to absolute internal key
    async updateFile(filePath: string): Promise<void> {
        const absolutePath = this.toAbsoluteNormalized(filePath);

        try {
            if (this.fileIndex[absolutePath]) {
                // remove existing vectors for this file (if any)
                await this.removeFileFromIndexAndVectorStore(absolutePath);
            }

            const newDocuments = await this.processFile(absolutePath);
            if (newDocuments.length === 0) {
                if (this.fileIndex[absolutePath]) {
                    delete this.fileIndex[absolutePath];
                    await this.saveFileIndex();
                }
                return;
            }

            // Generate unique IDs for the documents
            const ids = newDocuments.map((_, index) => `${absolutePath}-${index}`);
            
            if (!this.vectorStore) {
                console.log('🔄 Creating new PineconeStore...');
                this.vectorStore = await PineconeStore.fromDocuments(newDocuments, this.embeddings, {
                    pineconeIndex: this.pineconeIndex,
                    maxConcurrency: 5,
                });
            } else {
                await this.vectorStore.addDocuments(newDocuments, { ids });
            }

            // update file index with current timestamp
            this.fileIndex[absolutePath] = {
                lastIndexed: Date.now(),
                numberOfChunks: newDocuments.length
            };

            await this.saveFileIndex();

        } catch (error) {
            console.error(`error updating ${absolutePath}:`, error);
        }
    }

    async removeFileFromIndexAndVectorStore(filePathAbs: string): Promise<void> {
        const absolutePath = this.toAbsoluteNormalized(filePathAbs);

        if (!this.fileIndex[absolutePath] || !this.vectorStore) {
            if (this.fileIndex[absolutePath]) {
                delete this.fileIndex[absolutePath];
                await this.saveFileIndex();
            }
            return;
        }

        const chunks = this.fileIndex[absolutePath].numberOfChunks;
        const ids = Array.from({ length: chunks }, (_, i) => `${absolutePath}-${i}`);

        try {
            if (ids.length > 0) {
                await this.vectorStore.delete({ ids: ids });
            }
        } catch (error) {
            console.warn(`could not cleanly remove vectors for ${absolutePath}, will be overwritten:`, error);
        }

        delete this.fileIndex[absolutePath];
        await this.saveFileIndex();
    }

    async deleteFile(filePath: string): Promise<void> {
        const absolutePath = this.toAbsoluteNormalized(filePath);
        await this.removeFileFromIndexAndVectorStore(absolutePath);
    }

    startWatching(sourceDir: string = CODE_BASE_PATH): void {
        if (this.watcher) {
            this.watcher.close();
        }

        const absoluteSourceDir = path.resolve(sourceDir);
        const watchPattern = path.join(absoluteSourceDir, '**/*.{ts,tsx}');
        
        
        this.watcher = chokidar.watch(watchPattern, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**',
                '**/file_index.json',
                '**/faiss_index/**'
            ],
            persistent: true,
            ignoreInitial: true,
            followSymlinks: false,
            awaitWriteFinish: {
                stabilityThreshold: 50,  // Reduced from 200ms
                pollInterval: 50         
            },
            usePolling: false,           // Use native file system events
            interval: 100                 // Polling interval if needed
        });

        this.watcher
            .on('change', (filePath: string) => {
                const absolutePath = this.toAbsoluteNormalized(filePath);
                this.updateFile(absolutePath).catch(err => console.error('❌ updateFile failed', err));
            })
            .on('add', (filePath: string) => {
                const absolutePath = this.toAbsoluteNormalized(filePath);
                this.updateFile(absolutePath).catch(err => console.error('❌ addFile failed', err));
            })
            .on('unlink', (filePath: string) => {
                const absolutePath = this.toAbsoluteNormalized(filePath);
                this.removeFileFromIndexAndVectorStore(absolutePath).catch(err => console.error('❌ removeFile failed', err));
            })
            .on('error', (error: unknown) => {
                console.error(`watcher error:`, error);
            });
    }

    stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            console.log("stopped watching files");
        }
    }

    getVectorStore(): PineconeStore | null {
        return this.vectorStore;
    }

    async rebuildIndex(sourceDir: string = CODE_BASE_PATH): Promise<void> {
        console.log("rebuilding entire index...");

        try {
            await this.pineconeIndex.deleteAll();
        } catch (error) {
            console.error("error clearing pinecone index");
            return;
        }

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
                } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
                    const docs = await this.processFile(fullPath);
                    const absolutePath = this.toAbsoluteNormalized(fullPath);

                    if (docs.length > 0) {
                        allDocuments.push(...docs);
                        this.fileIndex[absolutePath] = {
                            lastIndexed: Date.now(),
                            numberOfChunks: docs.length
                        };
                    }
                }
            }
        };

        await processDirectory(sourceDir);

        console.log(`found ${allDocuments.length} documents to index`);

        if (allDocuments.length > 0) {
            this.vectorStore = await PineconeStore.fromDocuments(allDocuments, this.embeddings, {
                pineconeIndex: this.pineconeIndex,
                maxConcurrency: 5,
            });
        } else {
            this.vectorStore = null;
        }

        // Pinecone doesn't need explicit saving
        await this.saveFileIndex();

        console.log("index rebuilt successfully");
    }
}

export const incrementalVectorStore = new IncrementalVectorStore();
