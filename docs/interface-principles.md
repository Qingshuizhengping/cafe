# Interface principles

Each screen has one task: inventory, brewing, statistics, or backup.
Use headings, grouping, and explicit controls before explanatory paragraphs.
Keep actionable errors, privacy disclosures, units, field labels, and accessible names.
Put secondary explanations at the decision point in native details elements.

Prefer semantic HTML and existing native ES modules. Keep stable control IDs for
event bindings, automation, and assistive technology. Do not add a framework or
decorative renderer to solve a layout problem.

Use shared color tokens, solid surfaces, and one primary action style in both themes.
The optical WebGL renderer is no longer loaded by the app; its standalone source
remains available for reference. Navigation, storage, and business logic must not
depend on decoration.

Validate changes against task completion (UX), code and runtime complexity (DX),
and predictable semantic structure and control names (AX). Preserve data and
existing actions; verify navigation, editing, deduction and undo before release.
