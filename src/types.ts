export interface CodeChunk {
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    type: string;
}