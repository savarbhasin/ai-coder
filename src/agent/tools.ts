import { z } from "zod";
import { StructuredTool, tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { searchCodebase } from "../utils";
import { incrementalVectorStore } from "../lib/vector-store";
import { CODE_BASE_PATH, K } from "../config";
import { readdir, readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const searchCodebaseTool = tool(async (input) => {
    const vectorStore = incrementalVectorStore.getVectorStore();
    if (!vectorStore) {
        return "Vector store not initialized. Please wait for indexing to complete.";
    }
    const results = await searchCodebase(input.query, vectorStore, K);
    return results;
}, {
    name: "search_codebase",
    description: "Search the codebase for a function",
    schema: z.object({
        query: z.string().describe("The query to search the codebase for"),
    }),
});

const grepTool = tool(async (input) => {
    try {
        const targetPath = input.path || CODE_BASE_PATH;
        const flags = input.ignoreCase ? "-ri" : "-r";
        const { stdout } = await execAsync(`grep ${flags} --include="*.{js,ts,jsx,tsx}" -n "${input.pattern}" ${targetPath}`);
        
        // Parse grep output into structured format
        const lines = stdout.trim().split('\n').filter(line => line.length > 0);
        return lines.map(line => {
            const [filePath, lineNumber, ...contentParts] = line.split(':');
            return {
                file: path.relative(process.cwd(), filePath || ''),
                line: parseInt(lineNumber || '0'),
                content: contentParts.join(':').trim()
            };
        });
    } catch (error) {
        return `No matches found for pattern: ${input.pattern}`;
    }
}, {
    name: "grep",
    description: "Exact text/regex search. Use for: locating symbols, function signatures, interfaces, imports, error identifiers",
    schema: z.object({
        pattern: z.string().describe("The regex pattern to search for"),
        path: z.string().describe("Optional path to search in (defaults to codebase root)").optional(),
        ignoreCase: z.boolean().describe("Whether to ignore case").optional(),
    }),
});

const readFileTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.filePath);
        let content = await readFile(filePath, "utf8");
        
        if (input.startLine || input.endLine) {
            const lines = content.split('\n');
            const start = (input.startLine || 1) - 1;
            const end = input.endLine ? input.endLine : lines.length;
            content = lines.slice(start, end).join('\n');
            
            // Add line numbers for context
            const numberedLines = content.split('\n').map((line, index) => {
                const lineNum = start + index + 1;
                return `${lineNum.toString().padStart(4, ' ')}| ${line}`;
            });
            content = numberedLines.join('\n');
        }
        
        return content;
    } catch (error) {
        return `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "read_file",
    description: "Read a file from the codebase",
    schema: z.object({
        filePath: z.string().describe("The path to the file to read"),
        startLine: z.number().describe("Line number to start reading from (1-based)").optional(),
        endLine: z.number().describe("Line number to stop reading at (1-based)").optional(),
    }),
});

const writeFileTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.filePath);
        await writeFile(filePath, input.content, "utf8");
        return `File written successfully: ${input.filePath}`;
    } catch (error) {
        return `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "write_file",
    description: "Write a file to the codebase",
    schema: z.object({
        filePath: z.string().describe("The path to the file to write"),
        content: z.string().describe("The content to write to the file"),
    }),
});

// const editFileTool = tool(async (input) => {
//     try {
//         const fullPath = path.resolve(CODE_BASE_PATH, input.path);
//         let content = await readFile(fullPath, "utf8");
        
//         if (!content.includes(input.oldText)) {
//             return `Error: Could not find the specified text to replace in ${input.path}`;
//         }
        
//         const updatedContent = content.replace(input.oldText, input.newText);
//         await writeFile(fullPath, updatedContent, "utf8");
        
//         return `File edited successfully: ${input.path}\n\nReplaced:\n${input.oldText}\n\nWith:\n${input.newText}`;
//     } catch (error) {
//         return `Error editing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
//     }
// }, {
//     name: "edit_file",
//     description: "Edit a file by replacing old text with new text",
//     schema: z.object({
//         path: z.string().describe("The path to the file to edit"),
//         oldText: z.string().describe("The exact text to replace"),
//         newText: z.string().describe("The new text to replace it with"),
//     }),
// });

// Helper function for applying diff patches

// Improved applyDiffPatch: handles unified diffs with multiple hunks and common metadata

function applyDiffPatch(originalContent: string, diffPatch: string): { success: boolean; content?: string; error?: string } {
    try {
        const originalLines: string[] = originalContent.split('\n');
        const diffLines: string[] = diffPatch.split(/\r?\n/);

        // We'll iterate through diffLines, find hunks and apply them.
        let i = 0;
        const working: string[] = originalLines.slice(); // copy

        while (i < diffLines.length) {
            const raw = diffLines[i];
            const line: string = raw ?? '';

            // If it's a hunk header like: @@ -1,3 +1,4 @@ optional text
            const hunkHeaderMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
            if (!hunkHeaderMatch) {
                // Skip until the next hunk header
                i++;
                continue;
            }

            // parse target start (the + part). We assert it's present because of the regex.
            const targetStartStr = hunkHeaderMatch[3];
            if (!targetStartStr) {
                return { success: false, error: 'Malformed hunk header: missing + start index.' };
            }
            const targetStart = parseInt(targetStartStr, 10); // 1-based

            // Move pointer to first line of hunk body
            i++;

            // collect hunk body
            const hunkLines: string[] = [];
            while (i < diffLines.length) {
                const next = diffLines[i];
                if (next === undefined) break;
                // stop when next hunk header encountered
                if (/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/.test(next)) break;
                hunkLines.push(next);
                i++;
            }

            // Apply hunk to working lines
            // Convert 1-based targetStart to 0-based index in working
            let currentIndex = Math.max(0, targetStart - 1);

            for (let j = 0; j < hunkLines.length; j++) {
                const rawHunkLine = hunkLines[j];
                if (rawHunkLine === undefined) {
                    // should not happen, but guard for safety
                    continue;
                }

                // If the hunk line is a metadata like '\ No newline at end of file', skip it
                if (rawHunkLine.trim() === '\\ No newline at end of file') {
                    continue;
                }

                // Use charAt so empty strings are safe
                const firstChar = rawHunkLine.charAt(0);
                const content = rawHunkLine.length > 0 ? rawHunkLine.substring(1) : '';

                if (firstChar === '+') {
                    // Insert content at currentIndex, then advance currentIndex
                    working.splice(currentIndex, 0, content);
                    currentIndex++;
                } else if (firstChar === '-') {
                    // Remove: verify the working line matches the content to remove
                    const existing = working[currentIndex];
                    if (existing === undefined) {
                        return {
                            success: false,
                            error: `Hunk removal failed: expected to remove "${content}" at file line ${currentIndex + 1}, but file has no such line.`
                        };
                    }
                    if (existing !== content) {
                        const contextStart = Math.max(0, currentIndex - 2);
                        const contextEnd = Math.min(working.length - 1, currentIndex + 2);
                        const nearby = working.slice(contextStart, contextEnd + 1)
                            .map((l, idx) => `${contextStart + idx + 1}: ${l}`).join('\n');
                        return {
                            success: false,
                            error: `Hunk removal failed at file line ${currentIndex + 1}.\nExpected to remove: "${content}"\nFound: "${existing}"\n\nNearby file lines:\n${nearby}`
                        };
                    }
                    // Match -> remove and do NOT advance currentIndex (next original line shifts here)
                    working.splice(currentIndex, 1);
                } else {
                    // Context line:
                    const expected = rawHunkLine.startsWith(' ') ? content : rawHunkLine;
                    const existing = working[currentIndex];
                    if (existing === undefined) {
                        return {
                            success: false,
                            error: `Hunk context mismatch: expected "${expected}" at file line ${currentIndex + 1}, but file ended.`
                        };
                    }
                    if (existing !== expected) {
                        const contextStart = Math.max(0, currentIndex - 2);
                        const contextEnd = Math.min(working.length - 1, currentIndex + 2);
                        const nearby = working.slice(contextStart, contextEnd + 1)
                            .map((l, idx) => `${contextStart + idx + 1}: ${l}`).join('\n');
                        return {
                            success: false,
                            error: `Hunk context mismatch at file line ${currentIndex + 1}.\nExpected context: "${expected}"\nFound: "${existing}"\n\nNearby file lines:\n${nearby}`
                        };
                    }
                    currentIndex++;
                }
            }
            // proceed to next hunk (if any)
        }

        return { success: true, content: working.join('\n') };
    } catch (err) {
        return { success: false, error: `Failed to apply diff: ${err instanceof Error ? err.message : String(err)}` };
    }
}


const diffEditTool = tool(async (input) => {
    try {
        const fullPath = path.resolve(CODE_BASE_PATH, input.path);
        const originalContent = await readFile(fullPath, "utf8");

        const result = applyDiffPatch(originalContent, input.diff);

        if (!result.success) {
            return `Error applying diff to ${input.path}: ${result.error}`;
        }

        await writeFile(fullPath, result.content!, "utf8");

        const originalLines = originalContent.split(/\r?\n/).length;
        const newLines = result.content!.split(/\r?\n/).length;
        const linesChanged = Math.abs(newLines - originalLines);

        return `File edited successfully using diff: ${input.path}\n\nApplied diff patch:\n${input.diff}\n\nSummary: ${linesChanged} lines ${newLines > originalLines ? 'added' : newLines < originalLines ? 'removed' : 'changed'}`;
    } catch (error) {
        return `Error editing file with diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "diff_edit_file",
    description: `Edit a file using diff format. Provide a unified diff patch to apply multiple line changes at once. Use standard diff format with +/- prefixes.
    *** Begin Patch
    *** Update File: README.md
    @@ -1,1 +1,1 @@
    -# App
    +# My App
    @@ -4,0 +4,2 @@
    +Installation:
    +npm install
    *** End Patch`,
    schema: z.object({
        path: z.string().describe("The path to the file to edit"),
        diff: z.string().describe("The unified diff patch to apply. Use standard diff format:\n- Lines to remove (prefixed with '-')\n+ Lines to add (prefixed with '+')\n  Context lines (no prefix or leading space)\n@@ line numbers @@ (optional)"),
    }),
});

const globalFileSearchTool = tool(async (input) => {
    try {
        const files = await glob(input.pattern, { 
            cwd: CODE_BASE_PATH,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**']
        });
        
        return files.length > 0 
            ? files.map(file => path.relative(process.cwd(), path.join(CODE_BASE_PATH, file)))
            : `No files found matching pattern: ${input.pattern}`;
    } catch (error) {
        return `Error searching for files: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "global_file_search",
    description: "Search for files by name pattern or extension",
    schema: z.object({
        pattern: z.string().describe("The glob pattern to search for files (e.g., '*.ts', '**/components/**', 'App.*')"),
    }),
});

const listDirTool = tool(async (input) => {
    try {
        const targetPath = input.path ? path.resolve(CODE_BASE_PATH, input.path) : CODE_BASE_PATH;
        const entries = await readdir(targetPath, { withFileTypes: true });
        
        const formatted = entries
            .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
            .map(entry => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                path: path.relative(process.cwd(), path.join(targetPath, entry.name))
            }))
            .sort((a, b) => {
                // Directories first, then files
                if (a.type !== b.type) {
                    return a.type === 'directory' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
        
        return formatted.length > 0 
            ? formatted.map(item => `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`).join('\n')
            : 'Directory is empty';
    } catch (error) {
        return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "list_dir",
    description: "List the directory contents",
    schema: z.object({
        path: z.string().describe("The path to the directory to list. If no input is provided, list the current directory").optional(),
    }),
});

const runTerminalCmdTool = tool(async (input) => {
    try {
        const { stdout } = await execAsync(input.cmd);
        return stdout.trim();
    } catch (error) {
        return `Error running command: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "run_terminal_cmd",
    description: "Run a terminal command",
    schema: z.object({
        cmd: z.string().describe("The command to run"),
    }),
});



export const coderTools: StructuredTool[] = [
    searchCodebaseTool,
    grepTool,
    readFileTool,
    writeFileTool,
    diffEditTool,
    globalFileSearchTool,
    listDirTool,
    runTerminalCmdTool,
];

export const reviewerTools = [
    searchCodebaseTool,
    grepTool,
    readFileTool,
    globalFileSearchTool,
    listDirTool,
    runTerminalCmdTool,
];

export const coderToolNode = new ToolNode(coderTools);
export const reviewerToolNode = new ToolNode(reviewerTools);