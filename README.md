# agents

## types
1. **creator**
   - creates diff phases by exploring the codebase
2. **planner**
   - implements the phases one by one
3. **reviewer**
   - file reviewer
4. **coder** (NEW)
   - a cli coding assistant like gemini-cli

## features
- uses langgraph for agent orchestration
- setup langsmith for observability
- in memory conversation saver
- cli based access to the agents

## how to run
- `npm ci`
- `npm run dev`
