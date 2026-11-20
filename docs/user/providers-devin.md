# Devin

T3 Code runs the [Devin CLI](https://docs.devin.ai/cli) as an agent, using the Devin login on the
machine that runs the T3 Code server.

## Set up Devin

1. Install the Devin CLI on that machine. Its [guide](https://docs.devin.ai/cli) lists the
   installers.
2. Run `devin auth login` once in a terminal on that machine.
3. Open **Settings → Providers**, enable Devin, and refresh it.

If `devin` is not on the server's `PATH`, set its **Binary path**.

If you added Devin earlier through the ACP Registry, that instance keeps working, and its
threads stay on it. Devin no longer appears in the Registry list under **Add provider**.

## Models and options

The model picker lists the models your Devin account offers, with Devin's own default selected
first. **Thinking** and **Speed** appear for that default model; another model runs at Devin's
default level for it.

The model options also hold Devin's **Session Mode**: Code, Smart, Ask, Plan, or Bypass
Permissions. A new thread starts in the mode Devin's settings choose.

Type `/` for Devin's commands, such as `/compact`. Type `$` for your Devin skills. Skills that
live in a project's own folder are not listed; type `/` and the skill's name to run one.

Devin loads the MCP servers from its own configuration, `~/.config/devin/mcp_config.json`, along
with T3 Code's tools.

## Permissions

Devin runs its own tools under its session mode. When it asks for approval, T3 Code answers by
the thread's [permission mode](./permission-modes.md). Devin's commands run in T3 Code's
terminals, and those commands follow the thread's permission mode too. Under a
[managed permission cap](./managed-policy.md#permission-modes), T3 Code does not switch Devin to
a session mode above the cap.

## Not supported yet

- Commit messages, pull request text, branch names, and thread titles. Pick another provider for
  those.
