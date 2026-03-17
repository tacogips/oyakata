# Examples

This directory contains reference workflow bundles that can be validated or run
without copying them into `./.oyakata`.

## Available Examples

### `claude-oyakata-codex-coding`

Recommended mixed-backend reference:

- `oyakata` manager nodes use `claude-code-agent`
- implementation planning/finalization stays on `claude-code`
- the actual coding node uses `codex-agent`
- the workflow-level `oyakataPromptTemplate` explicitly prefers `oyakata gql`
- node prompt templates can read upstream mailbox data through `{{inbox.*}}`
- long node prompts live in `prompts/*.md` and are referenced by
  `node-{id}.json.promptTemplateFile`

Validate it:

```bash
bun run src/main.ts workflow validate claude-oyakata-codex-coding --workflow-root ./examples
```

Inspect it:

```bash
bun run src/main.ts workflow inspect claude-oyakata-codex-coding --workflow-root ./examples --output json
```

Run it with the bundled deterministic scenario:

```bash
bun run src/main.ts workflow run claude-oyakata-codex-coding \
  --workflow-root ./examples \
  --mock-scenario ./examples/claude-oyakata-codex-coding/mock-scenario.json \
  --output json
```

### `claude-oyakata-claude-worker`

Reference workflow for the case where a regular task node also uses
`claude-code-agent`:

- `oyakata` manager nodes use `claude-code-agent`
- the task node `claude-task` also uses `claude-code-agent`
- the bundle includes a deterministic mock scenario for validate/run demos

Validate it:

```bash
bun run src/main.ts workflow validate claude-oyakata-claude-worker --workflow-root ./examples
```

Inspect it:

```bash
bun run src/main.ts workflow inspect claude-oyakata-claude-worker --workflow-root ./examples --output json
```

Run it with the bundled deterministic scenario:

```bash
bun run src/main.ts workflow run claude-oyakata-claude-worker \
  --workflow-root ./examples \
  --mock-scenario ./examples/claude-oyakata-claude-worker/mock-scenario.json \
  --output json
```
