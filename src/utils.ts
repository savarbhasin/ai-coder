import { Command } from "@langchain/langgraph";
import { K, SIMILARITY_SCORE_THRESHOLD } from "./config";
import { PineconeStore } from "@langchain/pinecone";


export const approveToolExecution = () => new Command(
    { 
        resume: { 
            type: "accept" 
        } 
    }
);

export const rejectToolExecution = (feedback: string) => new Command(
    { 
        resume: { 
            type: "response", 
            feedback 
        } 
    }
);

export async function searchCodebase(query: string, vectorStore: PineconeStore, k: number = K) {
    const results = await vectorStore.similaritySearchWithScore(query, k);
    const filteredResults = results.filter(([, score]) => score >= SIMILARITY_SCORE_THRESHOLD);
    
    if (!filteredResults) { 
        return `No results found for query: "${query}"`;
    }
    
    return filteredResults.map((result, index) => {
        const [doc, score] = result;
        let out = ""
        out += `\n${index + 1}. File: ${doc.metadata.filePath} (Lines ${doc.metadata.startLine}-${doc.metadata.endLine})`;
        out += `   Content: ${doc.pageContent}\n`;
        return out;
    }).join("\n");
}



