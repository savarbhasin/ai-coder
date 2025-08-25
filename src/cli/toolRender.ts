import { BinaryOperatorAggregate, Messages, UpdateType } from '@langchain/langgraph';
import { ANSI, color, pretty, createErrorMessage, wrapText, wrapFileContent } from './ui';
import { AIMessage, BaseMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { ToolCall } from '@langchain/core/messages/tool';


export function renderToolCall(toolCall: ToolCall): string {
  if (!toolCall) {
    return "";
  }
  const outputs: string[] = [];
  
  const toolName = toolCall?.name;
  const args = toolCall?.args;
  
  const toolHeader = color(`\ncalling ${toolName}`, ANSI.yellow);
  outputs.push(toolHeader);
  
  if (args && Object.keys(args).length > 0) {
    const argsDisplay = Object.entries(args)
      .map(([key, value]) => {
        const displayValue = typeof value === 'string' && value.length > 100 
          ? `${value.slice(0, 100)}...`
          : typeof value === 'object' 
            ? JSON.stringify(value, null, 2).slice(0, 200) + (JSON.stringify(value).length > 200 ? '...' : '')
            : String(value);
        return `  ${color(key, ANSI.dim)}: ${displayValue}`;
      })
      .join('\n');
    
    outputs.push(argsDisplay);
  }
  outputs.push("");
  return outputs.join('\n');
}

export function renderToolMessage(msg: ToolMessage): string {
  const rawContent = typeof msg?.content === 'string' ? msg.content : pretty(msg?.content);
  const toolName = msg?.name || 'unknown';
  
  
  const toolHeader = color(`${toolName} output`, ANSI.cyan);
  
  let processedContent: string = rawContent;
  
  if (toolName === 'read_file' || toolName === 'write_file') {
    const lines = rawContent.split('\n');
    const maxLines = 50; // Show first 50 lines max
    const maxCharsPerLine = 200; // Truncate very long lines
    
    if (lines.length > maxLines) {
      const visibleLines = lines.slice(0, maxLines).map(line => 
        line.length > maxCharsPerLine ? `${line.substring(0, maxCharsPerLine)}...` : line
      );
      const remainingLines = lines.length - maxLines;
      visibleLines.push(color(`\n... ${remainingLines} more lines`, ANSI.dim));
      processedContent = visibleLines.join('\n');
    } else {
      processedContent = lines.map(line => 
        line.length > maxCharsPerLine ? `${line.substring(0, maxCharsPerLine)}...` : line
      ).join('\n');
    }
    
    // Apply file content wrapping to truncated content
    if (processedContent.includes('|')) {
      processedContent = wrapFileContent(processedContent);
    } else {
      processedContent = wrapText(processedContent);
    }
  } 
  
  const formattedContent = processedContent
    .split('\n')
    .map(line => line ? `  ${color(line, ANSI.dim)}` : line)
    .join('\n');
  
  return `${toolHeader}\n${formattedContent}\n`;
}

export function renderUsage(msg: AIMessage): string {
  try {
    const usage = msg?.usage_metadata;
    
    if (!usage) return '';
    
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = usage.total_tokens;
    
    if (totalTokens > 0) {
      const usageText = [
        `${color("tokens:", ANSI.magenta)} ${color(inputTokens.toLocaleString(), ANSI.cyan)} ${color("in", ANSI.dim)} ${color(outputTokens.toLocaleString(), ANSI.cyan)} ${color("out", ANSI.dim)} ${color(totalTokens.toLocaleString(), ANSI.bold + ANSI.magenta)} ${color("total", ANSI.dim)}`
      ].join('\n');
      
      return usageText + '\n';
    }
    
    return '';
  } catch {
    return '';
  }
}

export function renderAgentUpdate(values: UpdateType<{ messages: BinaryOperatorAggregate<BaseMessage[], Messages>; }>) {
  const messages = values?.messages ?? [];
  
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const outputs: string[] = [];

  for (const msg of messages) {
    const message = msg as BaseMessage;
    if (message.getType() === 'ai') {
      const aiMessage = message as AIMessage;
      
      // Handle tool calls from AI message
      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        for (const toolCall of aiMessage.tool_calls) {
          const toolCallsDisplay = renderToolCall(toolCall);
          if (toolCallsDisplay.trim()) {
            outputs.push(toolCallsDisplay);
          }
        }
      }
      
      // Handle AI message content
      const content = Array.isArray(aiMessage.content) 
        ? aiMessage.content.map(c => {
            if (typeof c === 'string') return c;
          }).join('\n')
        : aiMessage.content;
        
      if (content && content.trim()) {
        const icon = color("+ ", ANSI.green + ANSI.bold);
        const coloredText = color(content, ANSI.green);
        outputs.push(`${icon}${coloredText}`);
      }
      
      // Handle usage metadata
      const usage = renderUsage(aiMessage);
      if (usage && usage.trim()) {
        outputs.push(usage);
      }

    } else if (message.getType() === 'tool') {
      const toolMessage = message as ToolMessage;
      const result = renderToolMessage(toolMessage);
      if (result.trim()) {
        outputs.push(result);
      }

    } else if (message.getType() === 'human') {
      const humanMessage = message as HumanMessage;
      const content = Array.isArray(humanMessage.content)
        ? humanMessage.content.map(c => {
            if (typeof c === 'string') return c;
            if (typeof c === 'object' && c !== null && 'text' in c) return c.text as string;
            return JSON.stringify(c);
          }).join('\n')
        : humanMessage.content;
        
      if (content && content.trim()) {
        outputs.push(color(content, ANSI.blue));
      }
    } 
  }

  return outputs.filter(output => output.trim()).join('\n\n');
}

export function renderError(error: Error | string): string {
  const message = error instanceof Error ? error.message : error;
  return createErrorMessage(`Error: ${message}`);
}

