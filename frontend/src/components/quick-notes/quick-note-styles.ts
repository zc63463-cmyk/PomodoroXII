export const quickNoteStyles = {
  page:
    'quick-notes-surface relative min-h-full overflow-hidden px-4 py-6 text-[color:var(--qn-page-text)] before:pointer-events-none before:absolute before:inset-0 before:bg-[image:var(--qn-aura)] after:pointer-events-none after:absolute after:inset-0 after:bg-[image:var(--qn-grain)] after:bg-[length:42px_42px] after:opacity-[var(--qn-grain-opacity)] sm:px-6 lg:px-8',
  shell: 'mx-auto flex w-full max-w-4xl flex-col gap-5 transition-[max-width] duration-300 ease-out',
  shellWide: 'mx-auto flex w-full max-w-6xl flex-col gap-5 transition-[max-width] duration-300 ease-out',
  header: 'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
  headerActions: 'flex flex-col items-stretch gap-2 sm:items-end',
  surface: 'relative z-10',
  eyebrow: 'text-xs font-medium tracking-[0.24em] text-[color:var(--qn-subtle)] uppercase',
  title:
    'mt-1 bg-[image:var(--qn-title-gradient)] bg-clip-text text-3xl font-semibold tracking-tight text-transparent drop-shadow-[var(--qn-title-glow)]',
  subtitle: 'mt-2 max-w-xl text-sm leading-6 text-[color:var(--qn-muted)]',
  panel:
    'rounded-2xl border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-3 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-1 ring-[color:var(--qn-ring)]',
  panelRelaxed:
    'rounded-2xl border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-1 ring-[color:var(--qn-ring)]',
  composerFocusPanel:
    'quick-note-motion-panel rounded-[1.75rem] border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-2 ring-[color:var(--qn-accent-soft)] transition-all duration-300 ease-out',
  textarea:
    'min-h-28 resize-y rounded-xl border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-4 py-3 text-sm leading-6 text-[color:var(--qn-text-strong)] outline-none transition placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  textareaFocus:
    'min-h-[22rem] resize-y rounded-2xl border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-5 py-4 text-base leading-7 text-[color:var(--qn-text-strong)] outline-none transition-all duration-300 placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  workspaceStage:
    'quick-note-stage',
  workspaceGrid:
    'grid gap-5 transition-[grid-template-columns] duration-300 ease-out',
  workspaceMain: 'flex min-w-0 flex-col gap-5',
  focusEditGrid: 'grid gap-5',
  focusEditHint:
    'quick-note-motion-panel rounded-full border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-4 py-2 text-center text-xs text-[color:var(--qn-muted)] shadow-[var(--qn-shadow-soft)] backdrop-blur-xl',
  timelineDimmed:
    'quick-note-timeline-dimmed pointer-events-none max-h-56 overflow-hidden opacity-25 blur-[0.5px] [mask-image:linear-gradient(to_bottom,black,transparent)]',
  metaText: 'text-xs text-[color:var(--qn-muted)]',
  ghostButton:
    'text-[color:var(--qn-muted)] hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  primaryButton:
    'bg-[color:var(--qn-accent)] text-[color:var(--qn-accent-foreground)] shadow-[var(--qn-shadow-soft)] hover:bg-[color:var(--qn-accent-hover)] disabled:bg-[color:var(--qn-disabled)] disabled:text-[color:var(--qn-disabled-foreground)] disabled:shadow-none',
  outlineButton:
    'border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] text-[color:var(--qn-text)] shadow-[var(--qn-shadow-soft)] backdrop-blur-xl hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  searchWrap:
    'flex items-center gap-2 rounded-xl border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-3 py-2 shadow-[var(--qn-shadow-soft)] backdrop-blur-xl',
  searchInput:
    'border-0 bg-transparent px-0 text-[color:var(--qn-text-strong)] shadow-none placeholder:text-[color:var(--qn-placeholder)] focus-visible:ring-0',
  searchIcon: 'size-4 text-[color:var(--qn-subtle)]',
  timeline: 'flex flex-col gap-5',
  groupLabel:
    'sticky top-2 z-10 w-fit rounded-full border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-strong)] px-3 py-1 text-xs font-medium text-[color:var(--qn-text)] shadow-[var(--qn-shadow-soft)] backdrop-blur-xl',
  card:
    'group/card rounded-2xl border bg-[color:var(--qn-card)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-1 ring-[color:var(--qn-ring)] transition-[max-height,background-color,border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:bg-[color:var(--qn-card-hover)] hover:shadow-[var(--qn-shadow-soft)]',
  cardCollapsed:
    'max-h-[11.25rem] overflow-hidden',
  cardExpanded:
    'quick-note-expanded-card max-h-none overflow-visible border-[color:var(--qn-border-strong)] bg-[color:var(--qn-card-hover)] ring-2 ring-[color:var(--qn-accent-soft)] hover:translate-y-0',
  cardDefault: 'border-[color:var(--qn-border)]',
  cardPinned: 'border-[color:var(--qn-border-strong)] ring-2 ring-[color:var(--qn-accent-soft)]',
  cardAction:
    'text-[color:var(--qn-muted)] opacity-85 hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)] group-hover:opacity-100',
  cardDangerAction:
    'text-[color:var(--qn-muted)] opacity-85 hover:bg-[color:var(--qn-danger-soft)] hover:text-[color:var(--qn-danger)] group-hover:opacity-100',
  pinnedAction:
    'bg-[color:var(--qn-accent-soft)] text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-border-strong)] hover:bg-[color:var(--qn-accent-soft)]',
  cardTitle: 'truncate text-sm font-semibold text-[color:var(--qn-text-strong)]',
  cardBody:
    'mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-[color:var(--qn-text)]',
  cardFooter: 'mt-3 flex flex-wrap items-center gap-2 text-xs text-[color:var(--qn-muted)]',
  syncPending:
    'rounded-full bg-[color:var(--qn-chip)] px-2 py-0.5 text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-ring)]',
  syncFailed:
    'rounded-full bg-[color:var(--qn-danger-soft)] px-2 py-0.5 text-[color:var(--qn-danger)] ring-1 ring-[color:var(--qn-danger-border)]',
  tag:
    'rounded-full bg-[color:var(--qn-chip)] px-2 py-0.5 text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-ring)]',
  tagButton:
    'transition hover:bg-[color:var(--qn-accent-soft)] hover:text-[color:var(--qn-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--qn-border-strong)]',
  tagPreview: 'flex flex-wrap items-center gap-2',
  tagActive:
    'bg-[color:var(--qn-accent-soft)] text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-border-strong)]',
  mark:
    'rounded bg-[color:var(--qn-accent-soft)] px-0.5 text-[color:var(--qn-text-strong)] ring-1 ring-[color:var(--qn-border-strong)]',
  trashRow:
    'flex items-center justify-between gap-3 rounded-xl bg-[color:var(--qn-panel-muted)] px-3 py-2',
  trashTitle: 'min-w-0 truncate text-sm text-[color:var(--qn-text-strong)]',
  empty:
    'rounded-2xl border border-dashed border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-6 py-12 text-center shadow-[var(--qn-shadow-soft)] backdrop-blur-xl',
  emptyTitle: 'text-base font-semibold text-[color:var(--qn-text-strong)]',
  emptyDescription: 'mt-2 text-sm text-[color:var(--qn-muted)]',
  error:
    'rounded-xl border border-[color:var(--qn-danger-border)] bg-[color:var(--qn-danger-soft)] px-4 py-3 text-sm text-[color:var(--qn-danger)]',
  panelTitle: 'text-sm font-semibold text-[color:var(--qn-text-strong)]',
  focusPanelMotion:
    'quick-note-motion-panel',
  detailPanel:
    'lg:sticky lg:top-6 flex max-h-[calc(100svh-8rem)] min-h-0 flex-col gap-4 overflow-y-auto rounded-[1.75rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-1 ring-[color:var(--qn-ring)]',
  detailHeader: 'flex items-start justify-between gap-3 border-b border-[color:var(--qn-border)] pb-3',
  detailTitle:
    'mt-1 line-clamp-2 text-lg font-semibold leading-7 text-[color:var(--qn-text-strong)]',
  detailBody:
    'max-h-[42svh] overflow-y-auto whitespace-pre-wrap rounded-2xl bg-[color:var(--qn-panel-muted)] px-4 py-3 text-sm leading-7 text-[color:var(--qn-text)]',
  detailActions: 'flex flex-wrap items-center gap-2',
  metaGrid: 'grid grid-cols-2 gap-2 rounded-2xl bg-[color:var(--qn-panel-muted)] p-3',
  metaItem: 'min-w-0 rounded-xl px-2 py-1.5',
  metaWide: 'col-span-2 min-w-0 rounded-xl px-2 py-1.5',
  metaLabel:
    'block text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--qn-subtle)]',
  metaValue:
    'mt-1 block truncate text-xs font-medium text-[color:var(--qn-text-strong)]',
  metaValueDanger:
    'mt-1 block truncate text-xs font-medium text-[color:var(--qn-danger)]',
  readView:
    'grid min-h-[calc(100svh-12rem)] gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]',
  readArticle:
    'min-w-0 rounded-[2rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-2xl ring-1 ring-[color:var(--qn-ring)] sm:p-6',
  readHeader:
    'mb-5 flex flex-col gap-4 border-b border-[color:var(--qn-border)] pb-4 sm:flex-row sm:items-start sm:justify-between',
  readTitle:
    'mt-2 max-w-3xl text-2xl font-semibold tracking-tight text-[color:var(--qn-text-strong)] sm:text-3xl',
  readBody:
    'prose prose-sm max-w-none whitespace-pre-wrap text-[color:var(--qn-text)] prose-p:my-4 prose-p:leading-8',
  inlineEditorWrap:
    'quick-note-inline-editor grid gap-3 rounded-[1.5rem] border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-panel-muted)] p-3 ring-1 ring-[color:var(--qn-accent-soft)]',
  inlineTextarea:
    'min-h-[18rem] resize-y rounded-2xl border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-4 py-3 text-sm leading-7 text-[color:var(--qn-text-strong)] outline-none transition placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  notice:
    'rounded-xl border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-accent-soft)] px-3 py-2 text-xs text-[color:var(--qn-accent-readable)]',
  readAside:
    'hidden min-w-0 flex-col gap-4 lg:flex',
  asideBlock:
    'rounded-2xl border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] p-3 shadow-[var(--qn-shadow-soft)] backdrop-blur-xl',
  asideTitle:
    'mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--qn-subtle)]',
  asideRow:
    'flex items-center justify-between gap-3 border-t border-[color:var(--qn-border)] py-2 first:border-t-0 first:pt-0 last:pb-0',
}
