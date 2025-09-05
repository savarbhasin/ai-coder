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
    try {
        const results = await searchCodebase(input.query, vectorStore, K);
        if (!results || results.trim() === '') {
            return `No results found for query: "${input.query}"`;
        }
        
        return `Search results for "${input.query}":\n\n${results}`;
    } catch (error) {
        return `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "search_codebase",
    description: `Perform semantic vector search on the codebase to find relevant code snippets and files. 
    
    Use this tool when you need to:
    - Find code related to specific functionality (e.g., "authentication handling", "user login", "database queries")
    - Locate files that implement certain features or patterns
    - Discover similar code across the codebase
    - Search for code by natural language description rather than exact text
    
    This is different from grep - it finds semantically similar code, not exact text matches.
    Examples: "authentication handle", "JWT token validation", "React component props", "error handling middleware"`,
    schema: z.object({
        query: z.string().describe("Natural language description of what you're looking for in the codebase"),
    }),
});

const grepTool = tool(async (input) => {
    try {
        const targetPath = path.resolve(input.path || CODE_BASE_PATH);
        
        // Verify the target path exists
        try {
            await stat(targetPath);
        } catch {
            return `Path does not exist: ${targetPath}`;
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
                return line;
            }
            
            const filePath = line.substring(0, colonIndex);
            const lineNumber = line.substring(colonIndex + 1, secondColonIndex);
            const content = line.substring(secondColonIndex + 1);
            
            const relativePath = path.relative(CODE_BASE_PATH, filePath);
            return `${relativePath}:${lineNumber}: ${content.trim()}`;
        });
        
        // Limit results to prevent overwhelming output
        const maxResults = 50;
        if (results.length > maxResults) {
            return `Found ${results.length} matches for "${input.pattern}". Showing first ${maxResults}:\n\n${results.slice(0, maxResults).join('\n')}\n\n... and ${results.length - maxResults} more matches`;
        }
        
        return `Found ${results.length} matches for "${input.pattern}":\n\n${results.join('\n')}`;
    } catch (error) {
        return `Error executing grep: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "grep",
    description: `Search for exact text patterns in files using regular expressions.
    
    Use this tool when you need to:
    - Find exact string matches in code files
    - Search for specific variable names, function names, or class names
    - Locate import statements or specific syntax patterns
    - Find configuration values or environment variables
    - Search for TODO comments, error messages, or specific text
    
    Supports regex patterns and case-insensitive search. This finds exact text matches, unlike the semantic search.
    Examples: "import.*React", "function.*handleLogin", "TODO", "process.env", "className.*button"`,
    schema: z.object({
        pattern: z.string().describe("The exact text or regex pattern to search for in files"),
        path: z.string().describe("Optional specific directory path to search in (defaults to codebase root)").optional(),
        ignoreCase: z.boolean().describe("Whether to ignore case when matching (default: false)").optional(),
    }),
});

const readFileTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.filePath);
        
        // Security check: ensure file is within codebase
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return "Access denied. File must be within codebase directory.";
        }
        
        let content = await readFile(filePath, "utf8");
        const originalLength = content.split('\n').length;
        
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
            
            return `File: ${input.filePath} (lines ${start + 1}-${end} of ${originalLength})\n\n${content}`;
        }
        
        return `File: ${input.filePath} (${originalLength} lines)\n\n${content}`;
    } catch (error) {
        return `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "read_file",
    description: `Read the contents of a specific file from the codebase.
    
    Use this tool when you need to:
    - Examine the full content of a specific file
    - Read configuration files, package.json, or documentation
    - View source code to understand implementation details
    - Read specific line ranges from large files
    - Analyze file structure and dependencies
    
    Supports reading partial content by specifying line ranges to avoid overwhelming output with large files.
    Always use this before modifying files to understand the current state.`,
    schema: z.object({
        filePath: z.string().describe("The relative path to the file you want to read (e.g., 'src/components/App.tsx')"),
        startLine: z.number().describe("Optional: Line number to start reading from (1-based indexing)").optional(),
        endLine: z.number().describe("Optional: Line number to stop reading at (1-based indexing)").optional(),
    }),
});

const writeFileTool = tool(async (input) => {
    try {
        const filePath = path.resolve(CODE_BASE_PATH, input.filePath);
        
        // Security check: ensure file is within codebase
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return "Access denied. File must be within codebase directory.";
        }
        
        // Ensure directory exists
        const dir = path.dirname(filePath);
        await execAsync(`mkdir -p "${dir}"`);
        
        const contentLength = input.content.length;
        const lineCount = input.content.split('\n').length;
        
        await writeFile(filePath, input.content, "utf8");
        
        return `File written successfully: ${input.filePath}\nContent: ${contentLength} characters, ${lineCount} lines`;
    } catch (error) {
        return `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "write_file",
    description: `Create a new file or completely replace an existing file with new content.
    
    Use this tool when you need to:
    - Create brand new files (components, utilities, configuration files)
    - Completely rewrite a file with new content
    - Generate boilerplate code or starter templates
    - Create documentation, README files, or configuration files
    
    Warning: This will overwrite existing files completely. Use diff_edit_file for making targeted changes to existing files.
    Always read the existing file first if you want to preserve any existing content.`,
    schema: z.object({
        filePath: z.string().describe("The relative path where you want to create/write the file (e.g., 'src/components/NewComponent.tsx')"),
        content: z.string().describe("The complete content to write to the file"),
    }),
});

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
            return "Access denied. File must be within codebase directory.";
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

        return `File edited successfully: ${input.path}\n${linesChanged} lines ${newLines > originalLines ? 'added' : newLines < originalLines ? 'removed' : 'changed'}`;
    } catch (error) {
        return `Error editing file with diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "diff_edit_file",
    description: `Apply targeted edits to existing files using unified diff format. This is the preferred method for making precise changes to files.

    Use this tool when you need to:
    - Make specific changes to existing code (add/remove/modify lines)
    - Add new functions or imports to existing files
    - Fix bugs or update specific parts of a file
    - Apply code refactoring changes
    - Add or modify specific configuration options

    The diff format uses:
    - Lines starting with '+' are added
    - Lines starting with '-' are removed  
    - Lines starting with ' ' (space) are context lines that stay unchanged
    - @@ headers show line number ranges

    Example diff:
    @@ -1,3 +1,4 @@
     # My Project
    +This is a new line
     ## Overview
    -Old content
    +New content

    This is safer than write_file as it makes targeted changes rather than replacing entire files.`,
    schema: z.object({
        path: z.string().describe("The relative path to the file you want to edit (e.g., 'src/components/App.tsx')"),
        diff: z.string().describe("The unified diff patch to apply - must include @@ hunk headers and +/- prefixed lines"),
    }),
});

const globalFileSearchTool = tool(async (input) => {
    try {
        // Normalize the pattern and ensure it's safe
        const pattern = input.pattern.trim();
        if (!pattern) {
            return "Empty search pattern provided";
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
                    const results = altFiles.slice(0, 100).map(file => 
                        `${file.includes('.') ? '📄' : '📁'} ${file}`
                    );
                    const message = altFiles.length > 100 ? `Found ${altFiles.length} matches, showing first 100` : `Found ${altFiles.length} matches`;
                    return `${message} using pattern "${alt}":\n\n${results.join('\n')}`;
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
        const results = sortedFiles.slice(0, maxResults).map(file => 
            `${file.includes('.') ? '📄' : '📁'} ${file}`
        );

        if (files.length > maxResults) {
            return `Found ${files.length} matches for "${pattern}". Showing first ${maxResults}:\n\n${results.join('\n')}\n\n... and ${files.length - maxResults} more matches`;
        }

        return `Found ${files.length} matches for "${pattern}":\n\n${results.join('\n')}`;
    } catch (error) {
        return `Error searching for files: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "global_file_search",
    description: `Search for files and directories using glob patterns with wildcards.
    
    Use this tool when you need to:
    - Find files by name or extension (e.g., all TypeScript files, config files)
    - Locate directories with specific names
    - Search for files matching naming patterns
    - Find all files of a certain type across the entire codebase
    - Discover the project structure and file organization
    
    Glob pattern examples:
    - '*.ts' - All TypeScript files in root
    - '**/*.test.js' - All test files anywhere in the project
    - '**/components/**' - All files in any components directory
    - 'App.*' - Files named App with any extension
    - '**/*config*' - Any file with 'config' in the name
    - '*.json' - All JSON files in root directory
    
    This helps you understand the project structure and locate files before reading or editing them.`,
    schema: z.object({
        pattern: z.string().describe("The glob pattern to search for files/directories. Use * for any chars, ** for any dirs, ? for single char"),
    }),
});

const listDirTool = tool(async (input) => {
    try {
        const targetPath = input.path ? path.resolve(CODE_BASE_PATH, input.path) : CODE_BASE_PATH;
        
        const relativePath = path.relative(CODE_BASE_PATH, targetPath);
        if (relativePath.startsWith('..') && input.path) {
            return "Access denied. Path must be within codebase directory.";
        }
        
        const entries = await readdir(targetPath, { withFileTypes: true });
        
        const formatted = entries
            .filter(entry => {
                // Filter out hidden files and common build/cache directories
                if (entry.name.startsWith('.')) return false;
                if (['node_modules', 'dist', 'build', 'coverage', '.next', 'server'].includes(entry.name)) return false;
                return true;
            })
            .map(async entry => {
                const fullPath = path.join(targetPath, entry.name);
                const stats = await stat(fullPath);
                const icon = entry.isDirectory() ? '📁' : '📄';
                const size = entry.isFile() ? ` (${stats.size} bytes)` : '';
                return `${icon} ${entry.name}${size}`;
            });

        const items = await Promise.all(formatted);
        
        // Sort: directories first, then files, both alphabetically
        const sortedItems = items.sort((a, b) => {
            const aIsDir = a.startsWith('📁');
            const bIsDir = b.startsWith('📁');
            
            if (aIsDir !== bIsDir) {
                return aIsDir ? -1 : 1;
            }
            
            return a.localeCompare(b);
        });

        const currentPath = path.relative(CODE_BASE_PATH, targetPath) || '.';
        
        if (sortedItems.length === 0) {
            return `Directory: ${currentPath}\nEmpty directory (or contains only hidden/filtered files)`;
        }

        const dirCount = sortedItems.filter(item => item.startsWith('📁')).length;
        const fileCount = sortedItems.filter(item => item.startsWith('📄')).length;
        
        return `Directory: ${currentPath}\n${dirCount} directories, ${fileCount} files\n\n${sortedItems.join('\n')}`;
        
    } catch (error) {
        return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "list_dir",
    description: `List the contents of a directory showing files and subdirectories.
    
    Use this tool when you need to:
    - Explore the project structure and organization
    - See what files and folders exist in a specific directory
    - Understand the layout of components, utilities, or other code organization
    - Get an overview of a directory before deciding which files to read or modify
    - Navigate the codebase to understand its architecture
    
    Shows both files and directories, filtered to exclude common build artifacts and hidden files.
    This is essential for understanding project structure before making changes.`,
    schema: z.object({
        path: z.string().describe("The relative directory path to list (e.g., 'src/components'). Leave empty or use '.' for root directory").optional(),
    }),
});

const runTerminalCmdTool = tool(async (input) => {
    try {
        // Security: restrict dangerous commands
        const dangerous = ['rm', 'del', 'format', 'shutdown', 'reboot', 'sudo', 'chmod 777'];
        const cmdLower = input.cmd.toLowerCase();
        
        if (dangerous.some(cmd => cmdLower.includes(cmd))) {
            return `Command blocked for security reasons: ${input.cmd}`;
        }

        const { stdout, stderr } = await execAsync(input.cmd, {
            cwd: CODE_BASE_PATH,
            maxBuffer: 1024 * 1024, // 1MB limit
            timeout: 30000 // 30 second timeout
        });

        let result = `Command: ${input.cmd}\n`;
        if (stdout.trim()) {
            result += `Output:\n${stdout.trim()}`;
        }
        if (stderr.trim()) {
            result += `\n\nErrors:\n${stderr.trim()}`;
        }
        if (!stdout.trim() && !stderr.trim()) {
            result += "Command executed successfully (no output)";
        }

        return result;
    } catch (error) {
        return `Error running command: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}, {
    name: "run_terminal_cmd",
    description: `Execute terminal/shell commands in the codebase directory with security restrictions.
    
    Use this tool when you need to:
    - Run build commands (npm run build, yarn build)
    - Install dependencies (npm install, yarn add)
    - Run tests (npm test, jest, etc.)
    - Execute linting or formatting tools (eslint, prettier)
    - Run development servers or scripts
    - Check git status or run other version control commands
    - Execute package.json scripts
    
    Security restrictions prevent dangerous operations like file deletion, system modifications, etc.
    Useful for project setup, building, testing, and running development tools.
    
    Examples: "npm install", "npm run build", "git status", "eslint src/", "npm test"`,
    schema: z.object({
        cmd: z.string().describe("The shell command to execute (e.g., 'npm install', 'git status', 'npm run build')"),
    }),
});

const isDone = tool(async (input) => {
    return "done";
}, {
    name: "is_done",
    description: "If you believe you are done with the task. use this tool, no need to further give any answer.",
    schema: z.object({
        files: z.array(z.object({
            fileName: z.string().describe("The name of the file"),
            status: z.enum(["new", "modified"]).describe("Whether this is a new file or modified existing file"),
            todos: z.array(z.string()).describe("List of bullet points describing what needs to be done in this file"),
            constraints: z.string().describe("Any constraints or limitations for this file"),
            relationships: z.string().describe("How this file relates to other files or components"),
        })).describe("List of files and their completion status"),
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



