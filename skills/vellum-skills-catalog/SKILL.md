---
name: vellum-skills-catalog
description: Discover bundled skills and search/install community skills from the skills.sh registry
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🧩"
  vellum:
    category: "system"
    display-name: "Skills Catalog"
    activation-hints:
      - "what can you do"
      - "find a skill"
      - "install a skill"
      - "community skills"
      - "skills.sh"
      - "search for skills"
    avoid-when:
      - "User is asking about a specific bundled skill already visible in the catalog"
---

You can help the user discover what skills are available and find community skills to extend the assistant's capabilities.

## Bundled skills (first-party)

First-party skills are **bundled** with the assistant - they are compiled in and always available. They do not need to be installed or downloaded. To activate a bundled skill, use the `skill_load` tool:

```
skill_load skill=<skill-id>
```

The skill catalog shown in the system prompt lists all bundled skills with their IDs. When a user asks about capabilities, refer to this list to find relevant bundled skills and load them as needed.

## Community skills (skills.sh)

Community skills are published on the skills.sh registry and can be searched, inspected, and installed on demand using the `assistant skills` CLI.

### Searching for community skills

```bash
assistant skills search "<query>"
```

Returns matching skills with their slug, source, install counts, and security audit badges. Use this when the user asks for a capability not covered by bundled skills.

### Installing a community skill

**Trust model - check the source guardian before installing:**

- **Cue-owned** (`vellum-ai/*`): First-party skills published by the Cue team. Install these directly without prompting - they are vetted and trusted.
- **Third-party** (any other guardian): Ask the user for permission first. Present the skill name, source, audit results, and install count. Say something like: "I found a community skill that could help, but it's published by a third party - we haven't vetted it. Want to install it anyway?"

```bash
assistant skills add <owner>/<repo>@<skill-name>
```

For example:

```bash
assistant skills add vercel-labs/skills@find-skills
```

Once installed, the skill appears in the workspace skills directory and can be loaded with `skill_load` like any other skill.

## Presenting capabilities: use the skill_recommendations card

When the user asks what you can do for them ("What can you do?", "How can you help me?"), do not answer with a prose list. Emit a `ui_show` card with `surface_type: "card"` and `template: "skill_recommendations"`, picking the 3-5 skills most relevant to THIS user (strongest first), each with one ready-to-send Try-me `prompt` written in the user's voice:

```
ui_show surface_type=card data={
  title: "What I can do for you",
  body: "<one-line prose fallback>",
  template: "skill_recommendations",
  templateData: {
    skills: [
      { id: "inbox-management", title: "Inbox management", iconKey: "inbox",
        description: "Keep your inbox at zero without you reading the noise.",
        prompt: "Declutter my inbox",
        capabilities: ["Archive noise", "Surface threads that need you"],
        requirements: [{ label: "Gmail", status: "ready" }] }
    ]
  }
}
```

Compose the rows yourself from the bundled skills list and what you know about the user (their connectors, their routines). Say one sentence alongside the card; the card carries the list. See the `ui_show` tool description for the full templateData shape.

## Typical flow

1. **User asks about capabilities** - "Can you order food?" or "What can you do?"
   - Check the bundled skills list in the system prompt
   - Present the most relevant skills as a `skill_recommendations` card (see above)
   - Load any that match with `skill_load`

2. **User wants a capability not covered by bundled skills** - "Can you do X?"
   - Search with `assistant skills search "<query>"`
   - Present matching results with descriptions, install counts, and audit badges
   - Check the source guardian to determine trust level (see trust model above)
   - Install with `assistant skills add <owner>/<repo>@<skill-name>`
   - Load it with `skill_load`

3. **Skill has dependencies** - if `includes` lists other skill IDs, load those first with `skill_load`

## Notes

- Bundled skills are always available and do not need installation
- Community skills are installed to the workspace skills directory
- After installing a community skill, it is auto-enabled and immediately loadable
- Skills can be enabled or disabled via feature flags without uninstalling them
- Never install third-party community skills without explicit user confirmation
