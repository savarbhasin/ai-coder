import { CodeSplitter } from "llamaindex";
import Parser from "tree-sitter";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import * as fs from "fs/promises";
import * as path from "path";
import { CodeChunk } from "../types";
import { CODE_BASE_PATH, EMBEDDING_MODEL, MAX_CHARS, VECTOR_STORE_PATH } from "../config";

const TypeScript = require("tree-sitter-typescript").typescript;
const JavaScript = require("tree-sitter-javascript");


async function splitCodebase(sourceDir: string = CODE_BASE_PATH, indexDir: string = VECTOR_STORE_PATH): Promise<FaissStore> {
    // Initialize embeddings
    const embeddings = new OpenAIEmbeddings({
        model: EMBEDDING_MODEL,
    });

    // Initialize parser with TypeScript language
    const parser = new Parser();
    parser.setLanguage(TypeScript);

    const splitter = new CodeSplitter({
        maxChars: MAX_CHARS,
        getParser: () => parser
    });

    // Collect all code chunks from the source directory
    const codeChunks: CodeChunk[] = [];
    
    async function processDirectory(dirPath: string) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                // Skip node_modules and other common directories
                if (!["node_modules", ".git", "dist", "build"].includes(entry.name)) {
                    await processDirectory(fullPath);
                }
            } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                await processFile(fullPath);
            }
        }
    }

    async function processFile(filePath: string) {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            
            // Set appropriate language based on file extension
            if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
                parser.setLanguage(JavaScript);
            } else {
                parser.setLanguage(TypeScript);
            }
            
            // Split the code using the LlamaIndex CodeSplitter
            const chunks = splitter.splitText(content);
            
            // Create code chunk objects with metadata
            chunks.forEach((chunk, index) => {
                const lines = content.substring(0, content.indexOf(chunk)).split('\n').length;
                const endLines = lines + chunk.split('\n').length - 1;
                
                codeChunks.push({
                    content: chunk,
                    filePath: path.relative(process.cwd(), filePath),
                    startLine: lines,
                    endLine: endLines,
                    type: getChunkType(chunk)
                });
            });
            
            console.log(`Processed ${filePath}: ${chunks.length} chunks`);
        } catch (error) {
            console.error(`Error processing file ${filePath}:`, error);
        }
    }

    function getChunkType(chunk: string): string {
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

    // Process the source directory
    console.log(`Processing source directory: ${sourceDir}`);
    await processDirectory(sourceDir);
    
    console.log(`Found ${codeChunks.length} code chunks to index`);

    // Convert code chunks to LangChain documents
    const documents = codeChunks.map(chunk => new Document({
        pageContent: chunk.content,
        metadata: {
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            type: chunk.type,
            length: chunk.content.length
        }
    }));

    // Create FAISS vector store from documents
    console.log("Creating FAISS index with OpenAI embeddings...");
    const vectorStore = await FaissStore.fromDocuments(documents, embeddings);

    // Save the index to disk
    await fs.mkdir(indexDir, { recursive: true });
    await vectorStore.save(indexDir);
    console.log(`FAISS index saved to ${indexDir}`);

    return vectorStore;
}



export default splitCodebase;