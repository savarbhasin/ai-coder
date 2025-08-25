import * as readline from 'readline';
import { HumanResponse } from '@langchain/langgraph/prebuilt';
import { ANSI, color, getTerminalWidth, createTitledBox, createWaitingMessage, createInfoMessage, createErrorMessage, pretty, stripAnsi } from './ui';
import { ToolCall } from '@langchain/core/messages/tool';

export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

export async function promptUserInput(): Promise<string> {
  console.log("");
  const coloredPrompt = `${color(">", ANSI.blue + ANSI.bold)} `;
  const answer = await askQuestion(coloredPrompt);
  return answer;
}

export async function renderToolApprovalPrompt(
  toolCall: ToolCall,
  codeBasePath: string
): Promise<void> {
  if (!toolCall) {
    console.log(createErrorMessage("No tool call details available."));
    return;
  }

  const width = getTerminalWidth();
  const toolName = toolCall.name || "unknown";
  const args = toolCall.args || {};

  const description = `${toolName} (Execute tool)`;

  const content = pretty(args);
  
  console.log('\n' + createTitledBox(description, content, width, '🛠️'));
  console.log("");
}

export async function promptToolApproval(toolCall: ToolCall): Promise<HumanResponse> {
  console.log("")
  const toolName = toolCall.name || "unknown";
  const width = getTerminalWidth();

  // Create a beautiful approval prompt box
  const approvalTitle = `${color("🔐 Permission Required", ANSI.bold + ANSI.yellow)}`;
  const questionText = `Allow execution of: ${color(toolName, ANSI.bold + ANSI.cyan)}?`;
  
  const top = `╭${"─".repeat(width - 2)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const emptyLine = `│${" ".repeat(width - 2)}│`;
  
  console.log(top);
  console.log(`│ ${approvalTitle}${" ".repeat(Math.max(0, width - stripAnsi(approvalTitle).length - 3))}│`);
  console.log(emptyLine);
  console.log(`│ ${questionText}${" ".repeat(Math.max(0, width - stripAnsi(questionText).length - 3))}│`);
  console.log(emptyLine);
  
  const option1 = `${color("1.", ANSI.green + ANSI.bold)} ${color("Yes, run it", ANSI.green)}`;
  console.log(`│ ${option1}${" ".repeat(Math.max(0, width - stripAnsi(option1).length - 3))}│`);
  
  const option2 = `${color("2.", ANSI.yellow + ANSI.bold)} ${color("No, suggest changes", ANSI.yellow)}`;
  console.log(`│ ${option2}${" ".repeat(Math.max(0, width - stripAnsi(option2).length - 3))}│`);
  
  console.log(emptyLine);
  console.log(bottom);
  console.log("");
  
  console.log(createWaitingMessage("⌨️ Enter your choice (1 or 2):"));

  const decision = await askQuestion("> ");

  if (!decision) {
    return { 
      type: "response", 
      args: "User provided unclear response" 
    };
  }

  const choice = decision.trim().toLowerCase();

  if (choice === '1' || choice.startsWith('y')) {
    console.log(color("approved. executing tool...", ANSI.green));
    return { 
      type: "accept", 
      args: null 
    };
  } else if (choice === '2' || choice.includes('no') || choice.includes('esc')) {
    console.log(color("please provide feedback:", ANSI.yellow));
    const feedback = await askQuestion("what changes would you suggest? ");
    return {
      type: "response",
      args: feedback || "User rejected the action"
    };
  } else {
    console.log(color("❓ invalid choice. please enter 1 or 2.", ANSI.red));
    return await promptToolApproval(toolCall); // Retry
  }
}

export async function promptForFeedback(): Promise<string> {
  const feedback = await askQuestion("what changes would you suggest? ");
  return feedback || "User rejected the action";
}

export async function promptConfirmation(message: string): Promise<boolean> {
  console.log(createInfoMessage(`${message} (y/N)`));
  const response = await askQuestion("");
  return response.toLowerCase().startsWith('y');
}

export async function promptSelection(
  message: string,
  options: string[]
): Promise<number> {
  console.log(createInfoMessage(message));
  options.forEach((option, index) => {
    console.log(`${index + 1}. ${option}`);
  });

  while (true) {
    const response = await askQuestion("Enter choice (number): ");
    const choice = parseInt(response.trim(), 10);

    if (choice >= 1 && choice <= options.length) {
      return choice - 1;
    }

    console.log(createErrorMessage("Invalid choice. Please try again."));
  }
}

export function closePrompts(): void {
  rl.close();
}

export function setupGracefulShutdown(): void {
  process.on('SIGINT', () => {
    console.log("\n\ngoodbye!");
    rl.close();
    process.exit(0);
  });
}
