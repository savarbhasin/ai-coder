import { z } from "zod";
import { StructuredTool, tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { searchCodebase } from "../utils";
import { incrementalVectorStore } from "../lib/vector-store";
import { CODE_BASE_PATH, K } from "../config";
import { readdir, readFile, writeFile, stat } from "fs/promises";
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
        const targetPath = path.resolve(input.path || CODE_BASE_PATH);
        
        // Verify the target path exists
        try {
            await stat(targetPath);
        } catch {
            return `Error: Path does not exist: ${targetPath}`;
        }

        // Escape special characters in the pattern for shell safety
        const escapedPattern = input.pattern.replace(/'/g, "'\"'\"'");
        
        // Build grep command with proper file extensions and exclusions
        const flags = input.ignoreCase ? "-rni" : "-rn";
        const includePatterns = [
            "--include=*.js",
            "--include=*.ts", 
            "--include=*.jsx",
            "--include=*.tsx",
            "--include=*.json",
            "--include=*.md",
            "--include=*.txt",
            "--include=*.yml",
            "--include=*.yaml"
        ].join(" ");
        
        const excludePatterns = [
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "--exclude-dir=dist",
            "--exclude-dir=build",
            "--exclude-dir=.next",
            "--exclude-dir=coverage"
        ].join(" ");

        const cmd = `grep ${flags} ${includePatterns} ${excludePatterns} '${escapedPattern}' "${targetPath}" || true`;
        
        const { stdout, stderr } = await execAsync(cmd, { 
            maxBuffer: 1024 * 1024, // 1MB buffer
            cwd: CODE_BASE_PATH 
        });
        
        if (stderr && !stderr.includes("No such file")) {
            return `Grep warning: ${stderr}`;
        }
        
        if (!stdout.trim()) {
            return `No matches found for pattern: ${input.pattern}`;
        }

        // Parse grep output into structured format
        const lines = stdout.trim().split('\n').filter(line => line.length > 0);
        const results = lines.map(line => {
            const colonIndex = line.indexOf(':');
            const secondColonIndex = line.indexOf(':', colonIndex + 1);
            
            if (colonIndex === -1 || secondColonIndex === -1) {
                return {
                    file: 'unknown',
                    line: 0,
                    content: line
                };
            }
            
            const filePath = line.substring(0, colonIndex);
            const lineNumber = line.substring(colonIndex + 1, secondColonIndex);
            const content = line.substring(secondColonIndex + 1);
            
            return {
                file: path.relative(CODE_BASE_PATH, filePath),
                line: parseInt(lineNumber) || 0,
                content: content.trim()
            };
        });
        
        // Limit results to prevent overwhelming output
        const maxResults = 50;
        if (results.length > maxResults) {
            return {
                matches: results.slice(0, maxResults),
                truncated: true,
                totalMatches: results.length,
                message: `Showing first ${maxResults} of ${results.length} matches`
            };
        }
        
        return results;
    } catch (error) {
        return `Error executing grep: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "grep",
    description: "Search for text patterns in files. Supports regex patterns and case-insensitive search.",
    schema: z.object({
        pattern: z.string().describe("The text or regex pattern to search for"),
        path: z.string().describe("Optional specific path to search in (defaults to codebase root)").optional(),
        ignoreCase: z.boolean().describe("Whether to ignore case (default: false)").optional(),
    }),
});

const readFileTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.filePath);
        
        // Security check: ensure file is within codebase
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return `Error: Access denied. File must be within codebase directory.`;
        }
        
        let content = await readFile(filePath, "utf8");
        
        if (input.startLine || input.endLine) {
            const lines = content.split('\n');
            const start = Math.max(0, (input.startLine || 1) - 1);
            const end = Math.min(lines.length, input.endLine || lines.length);
            
            const selectedLines = lines.slice(start, end);
            
            // Add line numbers for context
            const numberedLines = selectedLines.map((line, index) => {
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
        
        // Security check: ensure file is within codebase
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return `Error: Access denied. File must be within codebase directory.`;
        }
        
        // Ensure directory exists
        const dir = path.dirname(filePath);
        await execAsync(`mkdir -p "${dir}"`);
        
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

// Improved diff patch application with better error handling and validation
function applyDiffPatch(originalContent: string, diffPatch: string): { success: boolean; content?: string; error?: string } {
    try {
        const originalLines: string[] = originalContent.split(/\r?\n/);
        const diffLines: string[] = diffPatch.split(/\r?\n/);

        let working: string[] = [...originalLines]; // Create a copy
        let i = 0;

        while (i < diffLines.length) {
            const line = diffLines[i]?.trim() || '';

            // Skip metadata lines
            if (line.startsWith('---') || line.startsWith('+++') || 
                line.startsWith('diff ') || line.startsWith('index ') || 
                line === '' || line.startsWith('*** ')) {
                i++;
                continue;
            }

            // Look for hunk header: @@ -oldStart,oldCount +newStart,newCount @@
            const hunkMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
            if (!hunkMatch) {
                i++;
                continue;
            }

            const oldStart = parseInt(hunkMatch[1] || "0") - 1; // Convert to 0-based
            const newStart = parseInt(hunkMatch[3] || "0") - 1; // Convert to 0-based
            
            i++; // Move to first hunk line

            // Process hunk lines
            let currentPos = newStart;
            const hunkLines: string[] = [];
            
            // Collect all hunk lines until next @@ or end
            while (i < diffLines.length) {
                const hunkLine = diffLines[i];
                if (!hunkLine) break;
                
                // Stop at next hunk or end of diff
                if (hunkLine.match(/^@@\s*-\d+/)) break;
                
                // Skip "No newline" messages
                if (hunkLine.startsWith('\\ No newline')) {
                    i++;
                    continue;
                }
                
                hunkLines.push(hunkLine);
                i++;
            }

            // Apply the hunk
            const result = applyHunk(working, hunkLines, currentPos);
            if (!result.success) {
                return { success: false, error: result?.error || "Unknown error" };
            }
            working = result.lines;
        }

        return { success: true, content: working.join('\n') };
    } catch (error) {
        return { success: false, error: `Failed to apply diff: ${error instanceof Error ? error.message : String(error)}` };
    }
}

function applyHunk(lines: string[], hunkLines: string[], startPos: number): { success: boolean; lines: string[]; error?: string } {
    const result = [...lines];
    let pos = startPos;

    for (const hunkLine of hunkLines) {
        if (!hunkLine) continue;
        
        const operation = hunkLine.charAt(0);
        const content = hunkLine.substring(1);

        switch (operation) {
            case '+':
                // Insert line
                result.splice(pos, 0, content);
                pos++;
                break;
                
            case '-':
                // Remove line - verify it matches
                if (pos >= result.length) {
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Cannot remove line at position ${pos + 1}: file has only ${result.length} lines` 
                    };
                }
                
                if (result[pos] !== content) {
                    const actualLine = result[pos] || '<empty>';
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Line mismatch at position ${pos + 1}:\nExpected: "${content}"\nActual: "${actualLine}"` 
                    };
                }
                
                result.splice(pos, 1);
                // Don't increment pos - next line shifts down
                break;
                
            case ' ':
                // Context line - verify it matches
                if (pos >= result.length) {
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Context line missing at position ${pos + 1}: file has only ${result.length} lines` 
                    };
                }
                
                if (result[pos] !== content) {
                    const actualLine = result[pos] || '<empty>';
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Context mismatch at line ${pos + 1}:\nExpected: "${content}"\nActual: "${actualLine}"` 
                    };
                }
                pos++;
                break;
                
            default:
                // Handle lines without prefix as context
                if (pos >= result.length) {
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Context line missing at position ${pos + 1}` 
                    };
                }
                
                if (result[pos] !== hunkLine) {
                    const actualLine = result[pos] || '<empty>';
                    return { 
                        success: false, 
                        lines: result, 
                        error: `Context mismatch at line ${pos + 1}:\nExpected: "${hunkLine}"\nActual: "${actualLine}"` 
                    };
                }
                pos++;
                break;
        }
    }

    return { success: true, lines: result };
}

const diffEditTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.path);
        
        // Security check
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return `Error: Access denied. File must be within codebase directory.`;
        }
        
        let originalContent;
        try {
            originalContent = await readFile(filePath, "utf8");
        } catch (error) {
            return `Error reading file ${input.path}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }

        const result = applyDiffPatch(originalContent, input.diff);

        if (!result.success) {
            return `Error applying diff to ${input.path}:\n${result.error}\n\nTip: Ensure the diff format is correct and the original lines match exactly.`;
        }

        await writeFile(filePath, result.content!, "utf8");

        const originalLines = originalContent.split(/\r?\n/).length;
        const newLines = result.content!.split(/\r?\n/).length;
        const linesChanged = Math.abs(newLines - originalLines);

        return `✅ File edited successfully: ${input.path}\n\nSummary: ${linesChanged} lines ${newLines > originalLines ? 'added' : newLines < originalLines ? 'removed' : 'changed'}`;
    } catch (error) {
        return `Error editing file with diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "diff_edit_file",
    description: `Edit a file using unified diff format. The diff should contain hunk headers (@@ -start,count +start,count @@) followed by lines prefixed with +/- for additions/deletions and space for context.

Example:
@@ -1,3 +1,4 @@
 # My Project
+This is a new line
 ## Overview
-Old content
+New content`,
    schema: z.object({
        path: z.string().describe("The path to the file to edit"),
        diff: z.string().describe("The unified diff patch to apply"),
    }),
});

const globalFileSearchTool = tool(async (input) => {
    try {
        // Normalize the pattern and ensure it's safe
        const pattern = input.pattern.trim();
        if (!pattern) {
            return "Error: Empty search pattern provided";
        }

        const options = {
            cwd: CODE_BASE_PATH,
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/build/**',
                '**/.git/**',
                '**/.next/**',
                '**/coverage/**',
                '**/.nyc_output/**',
                '**/tmp/**',
                '**/temp/**'
            ],
            nodir: false, // Include directories in results
            dot: false,   // Don't include hidden files by default
            absolute: false,
            matchBase: true, // Allow basename matching
        };

        const files = await glob(pattern, options);
        
        if (files.length === 0) {
            // Try some alternative patterns if no matches found
            const alternatives = [
                `**/${pattern}`,
                `**/${pattern}**`,
                `*${pattern}*`,
                `**/*${pattern}*`
            ];
            
            for (const alt of alternatives) {
                const altFiles = await glob(alt, options);
                if (altFiles.length > 0) {
                    return {
                        pattern: alt,
                        matches: altFiles.slice(0, 100).map(file => ({
                            path: file,
                            type: file.includes('.') ? 'file' : 'directory'
                        })),
                        total: altFiles.length,
                        message: altFiles.length > 100 ? `Found ${altFiles.length} matches, showing first 100` : `Found ${altFiles.length} matches`
                    };
                }
            }
            
            return `No files found matching pattern: "${pattern}". Tried alternatives but no matches found.`;
        }

        // Sort results: directories first, then by name
        const sortedFiles = files.sort((a, b) => {
            const aIsDir = !a.includes('.');
            const bIsDir = !b.includes('.');
            
            if (aIsDir !== bIsDir) {
                return aIsDir ? -1 : 1;
            }
            
            return a.localeCompare(b);
        });

        // Limit results to prevent overwhelming output
        const maxResults = 100;
        const results = sortedFiles.slice(0, maxResults).map(file => ({
            path: file,
            type: file.includes('.') ? 'file' : 'directory'
        }));

        if (files.length > maxResults) {
            return {
                matches: results,
                total: files.length,
                truncated: true,
                message: `Found ${files.length} matches, showing first ${maxResults}`
            };
        }

        return results;
    } catch (error) {
        return `Error searching for files: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "global_file_search",
    description: "Search for files using glob patterns. Supports wildcards: * (any chars), ** (any dirs), ? (single char). Examples: '*.ts', '**/components/**', 'App.*', '**/*test*'",
    schema: z.object({
        pattern: z.string().describe("The glob pattern to search for files"),
    }),
});

const listDirTool = tool(async (input) => {
    try {
        const targetPath = input.path ? path.resolve(CODE_BASE_PATH, input.path) : CODE_BASE_PATH;
        
        // Security check
        const relativePath = path.relative(CODE_BASE_PATH, targetPath);
        if (relativePath.startsWith('..') && input.path) {
            return `Error: Access denied. Path must be within codebase directory.`;
        }
        
        const entries = await readdir(targetPath, { withFileTypes: true });
        
        const formatted = entries
            .filter(entry => {
                // Filter out hidden files and common build/cache directories
                if (entry.name.startsWith('.')) return false;
                if (['node_modules', 'dist', 'build', 'coverage', '.next'].includes(entry.name)) return false;
                return true;
            })
            .map(async entry => {
                const fullPath = path.join(targetPath, entry.name);
                const stats = await stat(fullPath);
                return {
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    size: entry.isFile() ? stats.size : null,
                    modified: stats.mtime.toISOString().split('T')[0], // Just date part
                    path: path.relative(CODE_BASE_PATH, fullPath)
                };
            });

        const items = await Promise.all(formatted);
        
        // Sort: directories first, then files, both alphabetically
        items.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'directory' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        if (items.length === 0) {
            return 'Directory is empty (or contains only hidden/filtered files)';
        }

        // Format output
        const output = items.map(item => {
            const icon = item.type === 'directory' ? '📁' : '📄';
            const sizeStr = item.size !== null ? ` (${formatBytes(item.size)})` : '';
            return `${icon} ${item.name}${sizeStr} - ${item.modified}`;
        }).join('\n');

        return `Contents of ${path.relative(CODE_BASE_PATH, targetPath) || '.'}:\n\n${output}`;
        
    } catch (error) {
        return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "list_dir",
    description: "List directory contents with file sizes and modification dates",
    schema: z.object({
        path: z.string().describe("The path to the directory to list (optional, defaults to root)").optional(),
    }),
});

const runTerminalCmdTool = tool(async (input) => {
    try {
        // Security: restrict dangerous commands
        const dangerous = ['rm', 'del', 'format', 'shutdown', 'reboot', 'sudo', 'chmod 777'];
        const cmdLower = input.cmd.toLowerCase();
        
        if (dangerous.some(cmd => cmdLower.includes(cmd))) {
            return `Error: Command blocked for security reasons: ${input.cmd}`;
        }

        const { stdout, stderr } = await execAsync(input.cmd, {
            cwd: CODE_BASE_PATH,
            maxBuffer: 1024 * 1024, // 1MB limit
            timeout: 30000 // 30 second timeout
        });

        let result = stdout.trim();
        if (stderr) {
            result += stderr ? `\nStderr: ${stderr}` : '';
        }

        return result || 'Command executed successfully (no output)';
    } catch (error) {
        return `Error running command: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "run_terminal_cmd",
    description: "Run a terminal command in the codebase directory (with security restrictions)",
    schema: z.object({
        cmd: z.string().describe("The command to run"),
    }),
});

// Helper function to format file sizes
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

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