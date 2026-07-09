# Quick Note Tag Autocomplete Design

## Goal

Add lightweight `#` tag autocomplete to the Quick Notes composer so users can discover and insert existing tags while typing, similar to mature command/mention suggest patterns, without replacing the current textarea editor.

## References

- WAI-ARIA Authoring Practices combobox pattern: use predictable listbox semantics and keyboard navigation.
- CodeMirror autocomplete model: keep completion candidates as a derived source separate from editor state.

## Scope

- Only `#` tag autocomplete is included.
- `@` mentions, note references, task references, people references, and slash commands are out of scope.
- No new tag entity, table, schema, or sync protocol change.
- No session, timer, or system session changes.
- Quick Preview, Detail Read, Focus Edit, and Markdown rendering semantics stay unchanged.

## UX

The composer opens a suggestion popover when the caret is inside a tag token that starts with `#`.

Examples:

- `#` shows the top existing active-note tags.
- `#wo` filters to tags such as `work` and `work/frontend`.
- Pressing `ArrowDown` or `ArrowUp` changes the active option.
- Pressing `Enter` or `Tab` replaces the current token with `#tag `.
- Pressing `Escape` closes the suggestion popover and keeps the draft unchanged.
- Clicking an option inserts that tag.
- If no tags match, no option is inserted and the user can keep typing a new tag.

The popover appears below the composer textarea, not as a modal. It should not clear or isolate the timeline. In focus edit, it remains inside the right column composer area.

## Data Flow

`QuickNotesWorkspace` already derives popular active-note tags through `getQuickNoteTagStats(allQuickNotes)`. The autocomplete should reuse that derived list and pass it to `QuickNoteComposer`.

`QuickNoteComposer` owns transient UI state:

- current textarea caret position
- current tag query range
- filtered suggestions
- active suggestion index

Selecting a suggestion calls `onDraftChange(nextDraft)` with the replaced token and restores the caret after React applies the new value.

## Component Boundary

Create a small pure helper module for token and suggestion logic:

- `getQuickNoteTagAutocompleteState(value, caretIndex, tags)`
- `applyQuickNoteTagAutocomplete(value, range, tag)`

Keep DOM and keyboard handling in `QuickNoteComposer`.

## Accessibility

Use stable roles and attributes:

- textarea keeps `aria-label="小记内容"`
- suggestion container uses `role="listbox"`
- options use `role="option"`
- the selected option has `aria-selected="true"`
- textarea references the listbox with `aria-controls` while open

Keyboard behavior follows the expected combobox/listbox pattern for arrows, Enter, Tab, and Escape.

## Testing

Add pure helper tests for:

- detecting a `#` token at the caret
- filtering and limiting suggestions
- replacing the active token with `#tag `
- not opening outside a tag token

Add view tests for:

- typing `#w` shows matching suggestions
- `ArrowDown` plus `Enter` inserts the selected tag
- `Tab` inserts the current suggestion
- `Escape` closes suggestions without exiting focus edit
- mouse click inserts a suggestion
- no-match input does not block free typing
- existing popular tag chips still work
