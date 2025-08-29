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

## demo
- cli based access to the project
- for demo purposes, a quick frontend was vibecoded — you can check out the demo video here: [link]()  

## how to run
- `npm install --legacy-peer-deps`
- `npm run dev`
