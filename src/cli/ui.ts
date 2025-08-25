import { ANSIColors, ToolDescriptions } from './types';

// ANSI Color codes for console output
export const ANSI: ANSIColors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m"
};

/**
 * Colors text with the specified ANSI code
 */
export function color(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

/**
 * Creates a divider line with optional label
 */
export function divider(label?: string): string {
  const line = "─".repeat(50);
  return label ? `${line} ${label} ${line}` : `${line}${line}`;
}

/**
 * Truncates text to a maximum length with ellipsis
 */
export function truncate(text: string, max = 1200): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more)` : text;
}

/**
 * Safely parses JSON string, returns null on failure
 */
export function safeParseJSON(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Pretty prints an object as JSON string
 */
export function pretty(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * Gets the current terminal width with fallback
 */
export function getTerminalWidth(defaultWidth = 100): number {
  const w = process.stdout.columns || defaultWidth;
  return Math.max(40, Math.min(w, 120));
}

/**
 * Creates a bordered box for displaying content with enhanced styling
 */
export function createBorderedBox(content: string, width?: number, style: 'normal' | 'double' | 'rounded' = 'normal'): string {
  const boxWidth = width || getTerminalWidth();
  
  let chars: { top: string; bottom: string; horizontal: string; vertical: string; topLeft: string; topRight: string; bottomLeft: string; bottomRight: string };
  
  switch (style) {
    case 'double':
      chars = { top: '╔', bottom: '╚', horizontal: '═', vertical: '║', topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝' };
      break;
    case 'rounded':
      chars = { top: '╭', bottom: '╰', horizontal: '─', vertical: '│', topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯' };
      break;
    default:
      chars = { top: '┌', bottom: '└', horizontal: '─', vertical: '│', topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘' };
  }
  
  const top = `${chars.topLeft}${chars.horizontal.repeat(boxWidth - 2)}${chars.topRight}`;
  const bottom = `${chars.bottomLeft}${chars.horizontal.repeat(boxWidth - 2)}${chars.bottomRight}`;

  const lines = content.split('\n');
  const paddedLines = lines.map(line => {
    const displayLength = stripAnsi(line).length;
    const padding = " ".repeat(Math.max(0, boxWidth - displayLength - 3));
    return `${chars.vertical} ${line}${padding}${chars.vertical}`;
  });

  return [top, ...paddedLines, bottom].join('\n');
}

/**
 * Creates a clean bordered box like in the reference image
 */
export function createTitledBox(title: string, content: string, width?: number, icon: string = '❓'): string {
  const boxWidth = width || getTerminalWidth();
  const top = `╭${"─".repeat(boxWidth - 2)}╮`;
  const bottom = `╰${"─".repeat(boxWidth - 2)}╯`;

  // Use the public stripAnsi function

  const titleLine = `│ ${color(icon, ANSI.cyan)} ${color(title, ANSI.bold)}`;
  const paddedTitle = titleLine + " ".repeat(Math.max(0, boxWidth - stripAnsi(titleLine).length - 1)) + "│";
  
  const emptyLine = `│${" ".repeat(boxWidth - 2)}│`;

  const contentLines = content.split('\n').map(line => {
    const contentLine = `│   ${line}`;
    return contentLine + " ".repeat(Math.max(0, boxWidth - stripAnsi(contentLine).length - 1)) + "│";
  });

  return [top, paddedTitle, emptyLine, ...contentLines, emptyLine, bottom].join('\n');
}

/**
 * Gets tool description for display
 */
export function getToolDescription(toolName: string): string {
  const descriptions: ToolDescriptions = {
    'run_terminal_cmd': 'Execute shell command',
    'edit_file': 'Modify file content',
    'diff_edit_file': 'Edit file using diff patch',
    'read_file': 'Read file contents',
    'write_file': 'Create new file',
    'search_codebase': 'Search in codebase',
    'grep': 'Search for text patterns',
    'list_dir': 'List directory contents',
    'global_file_search': 'Find files by pattern',
    'done_task': 'Mark task as done'
  };
  return descriptions[toolName] || 'Execute tool';
}

/**
 * Formats a question prompt with consistent styling
 */
export function formatQuestion(question: string): string {
  const width = getTerminalWidth();
  const top = `\n╭${"─".repeat(width - 2)}╮`;
  const mid = `│ ${" ".repeat(width - 4)} │`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const questionLine = `│ > ${question}`;

  return [top, mid, questionLine, bottom].join('\n');
}

/**
 * Creates a success message with consistent styling
 */
export function createSuccessMessage(message: string): string {
  return color(`✅ ${message}`, ANSI.green);
}

/**
 * Creates an error message with consistent styling
 */
export function createErrorMessage(message: string): string {
  return color(`❌ ${message}`, ANSI.red);
}

/**
 * Creates an info message with consistent styling
 */
export function createInfoMessage(message: string): string {
  return color(`ℹ️ ${message}`, ANSI.blue);
}

/**
 * Creates a warning message with consistent styling
 */
export function createWarningMessage(message: string): string {
  return color(`⚠️ ${message}`, ANSI.yellow);
}

/**
 * Creates a waiting/loading message with consistent styling
 */
export function createWaitingMessage(message: string): string {
  return color(`⏳ ${message}`, ANSI.dim);
}

/**
 * Wraps text to fit within specified width, preserving indentation
 */
export function wrapText(text: string, width?: number, preserveIndentation = true): string {
  const maxWidth = width || getTerminalWidth() - 4; // Account for borders
  const lines = text.split('\n');
  const wrappedLines: string[] = [];

  for (const line of lines) {
    if (line.length <= maxWidth) {
      wrappedLines.push(line);
      continue;
    }

    // Extract leading whitespace for indentation preservation
    const indentMatch = line.match(/^(\s*)/);
    const indent = preserveIndentation && indentMatch && indentMatch[1] ? indentMatch[1] : '';
    const content = line.substring(indent.length);
    
    // Split long line into chunks
    let remaining = content;
    let isFirst = true;
    
    while (remaining.length > 0) {
      const availableWidth = maxWidth - (isFirst ? indent.length : indent.length + 2);
      
      if (remaining.length <= availableWidth) {
        const prefix = isFirst ? indent : indent + '  ';
        wrappedLines.push(prefix + remaining);
        break;
      }
      
      // Find a good break point (space, hyphen, or forced break)
      let breakPoint = availableWidth;
      const lastSpace = remaining.lastIndexOf(' ', availableWidth);
      const lastHyphen = remaining.lastIndexOf('-', availableWidth);
      
      if (lastSpace > availableWidth * 0.7) {
        breakPoint = lastSpace + 1;
      } else if (lastHyphen > availableWidth * 0.7) {
        breakPoint = lastHyphen + 1;
      }
      
      const prefix = isFirst ? indent : indent + '  ';
      wrappedLines.push(prefix + remaining.substring(0, breakPoint).trimEnd());
      remaining = remaining.substring(breakPoint).trimStart();
      isFirst = false;
    }
  }

  return wrappedLines.join('\n');
}

/**
 * Wraps file content with line numbers, preserving formatting
 */
export function wrapFileContent(content: string, width?: number): string {
  const maxWidth = width || getTerminalWidth() - 4;
  const lines = content.split('\n');
  const wrappedLines: string[] = [];

  for (const line of lines) {
    // Check if line has line numbers (format: "   123| content")
    const lineNumberMatch = line.match(/^(\s*\d+\|\s*)(.*)/);
    
    if (lineNumberMatch && lineNumberMatch.length >= 3) {
      const linePrefix = lineNumberMatch[1] || '';
      const lineContent = lineNumberMatch[2] || '';
      const prefixLength = stripAnsi(linePrefix).length;
      const availableWidth = maxWidth - prefixLength;
      
      if (lineContent.length <= availableWidth) {
        wrappedLines.push(line);
      } else {
        // Split the content part while preserving line number prefix
        let remaining = lineContent;
        let isFirst = true;
        
        while (remaining && remaining.length > 0) {
          const chunkWidth = Math.min(availableWidth, remaining.length);
          const chunk = remaining.substring(0, chunkWidth);
          
          if (isFirst) {
            wrappedLines.push(linePrefix + chunk);
            isFirst = false;
          } else {
            // Continuation lines get indented
            const continuationPrefix = ' '.repeat(prefixLength);
            wrappedLines.push(continuationPrefix + chunk);
          }
          
          remaining = remaining.substring(chunkWidth);
        }
      }
    } else {
      // Regular line without line numbers, use standard wrapping
      wrappedLines.push(wrapText(line, maxWidth, true));
    }
  }

  return wrappedLines.join('\n');
}

/**
 * Helper to strip ANSI codes for length calculation (moved to public)
 */
export function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}
