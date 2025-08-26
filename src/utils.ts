import { Command } from "@langchain/langgraph";
import { K } from "./config";
import { PineconeStore } from "@langchain/pinecone";


export const approveToolExecution = () => new Command(
    { 
        resume: { 
            action: "approve" 
        } 
    }
);

export const rejectToolExecution = (feedback: string) => new Command(
    { 
        resume: { 
            action: "feedback", 
            feedback 
        } 
    }
);

export async function searchCodebase(query: string, vectorStore: PineconeStore, k: number = K) {
    const results = await vectorStore.similaritySearchWithScore(query, k);
    
    return results.map((result, index) => {
        const [doc, score] = result;
        let out = ""
        out += `\n${index + 1}. File: ${doc.metadata.filePath} (Lines ${doc.metadata.startLine}-${doc.metadata.endLine})`;
        out += `   Content: ${doc.pageContent}\n`;
        return out;
    }).join("\n");
}



