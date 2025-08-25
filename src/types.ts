export interface CodeChunk {
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    type: string;
}

export interface FileIndex {
    [filePath: string]: { 
        lastIndexed: number; // timestamp of last index
        numberOfChunks: number; // number of code chunks in the file
    };
}