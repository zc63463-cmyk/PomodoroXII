export const quickNoteStyles = {
  page:
    'quick-notes-surface relative min-h-full overflow-hidden px-4 py-7 text-[color:var(--qn-page-text)] before:pointer-events-none before:absolute before:inset-0 before:bg-[image:var(--qn-aura)] after:pointer-events-none after:absolute after:inset-0 after:bg-[image:var(--qn-grain)] after:bg-[length:48px_48px] after:opacity-[var(--qn-grain-opacity)] sm:px-6 lg:px-8',
  shell: 'mx-auto flex w-full max-w-5xl flex-col gap-5 transition-[max-width] duration-300 ease-out',
  shellWide: 'mx-auto flex w-full max-w-7xl flex-col gap-5 transition-[max-width] duration-300 ease-out',
  header: 'flex flex-col gap-4 rounded-[2rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-5 py-4 shadow-[var(--qn-shadow-soft)] backdrop-blur-[28px] sm:flex-row sm:items-end sm:justify-between',
  headerActions: 'flex flex-col items-stretch gap-2 sm:items-end',
  surface: 'relative z-10',
  eyebrow: 'text-xs font-semibold tracking-[0.18em] text-[color:var(--qn-subtle)] uppercase',
  title:
    'mt-1 text-4xl font-semibold tracking-[-0.055em] text-[color:var(--qn-text-strong)] sm:text-5xl',
  subtitle: 'mt-2 max-w-2xl text-sm leading-6 text-[color:var(--qn-muted)]',
  panel:
    'rounded-[1.375rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-3 shadow-[var(--qn-shadow-soft)] backdrop-blur-[24px]',
  panelRelaxed:
    'rounded-[1.5rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow-soft)] backdrop-blur-[24px]',
  composerFocusPanel:
    'quick-note-motion-panel rounded-[2rem] border border-[color:var(--qn-panel-highlight)] bg-[color:var(--qn-paper)] p-5 shadow-[var(--qn-shadow)] backdrop-blur-[30px] ring-1 ring-[color:var(--qn-ring)] transition-all duration-300 ease-out',
  textarea:
    'min-h-28 resize-y rounded-[1.125rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-4 py-3 text-sm leading-6 text-[color:var(--qn-text-strong)] outline-none transition placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  textareaFocus:
    'h-[clamp(20rem,calc(100dvh-23rem),26rem)] min-h-[20rem] max-h-[26rem] resize-y overflow-y-auto rounded-[1.625rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-5 py-4 text-lg leading-8 text-[color:var(--qn-text-strong)] outline-none transition-all duration-300 placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  workspaceStage:
    'quick-note-stage rounded-[2rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-stage)] p-4 shadow-[var(--qn-shadow)] backdrop-blur-[30px]',
  workspaceGrid:
    'grid gap-5 transition-[grid-template-columns] duration-300 ease-out lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start',
  workspaceMain: 'order-1 flex min-w-0 flex-col gap-5 lg:order-none',
  focusEditGrid:
    'grid gap-5 transition-[grid-template-columns] duration-300 ease-out lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start',
  focusEditHint:
    'quick-note-motion-panel rounded-full border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-4 py-2 text-center text-xs text-[color:var(--qn-muted)] shadow-[var(--qn-shadow-soft)] backdrop-blur-[22px]',
  focusEditTimelineSink:
    'quick-note-focus-timeline-sink pointer-events-none select-none transition-[opacity,transform] duration-300 ease-out',
  metaText: 'text-xs text-[color:var(--qn-muted)]',
  ghostButton:
    'text-[color:var(--qn-muted)] hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  primaryButton:
    'rounded-full bg-[color:var(--qn-accent)] text-[color:var(--qn-accent-foreground)] shadow-[var(--qn-accent-shadow)] hover:bg-[color:var(--qn-accent-hover)] disabled:bg-[color:var(--qn-disabled)] disabled:text-[color:var(--qn-disabled-foreground)] disabled:shadow-none',
  outlineButton:
    'rounded-full border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] text-[color:var(--qn-text)] shadow-[var(--qn-shadow-soft)] backdrop-blur-[22px] hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  searchWrap:
    'flex w-full items-center gap-2 rounded-[0.9rem] border border-transparent bg-[color:var(--qn-search)] px-3 py-2 shadow-none backdrop-blur-[18px]',
  searchInput:
    'border-0 bg-transparent px-0 text-[color:var(--qn-text-strong)] shadow-none placeholder:text-[color:var(--qn-placeholder)] focus-visible:ring-0',
  searchIcon: 'size-4 text-[color:var(--qn-subtle)]',
  explorer: 'order-2 flex min-w-0 flex-col gap-4 lg:order-none lg:sticky lg:top-5 lg:self-start',
  explorerPanel:
    'rounded-[1.5rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] p-3 shadow-[var(--qn-shadow-soft)] backdrop-blur-[24px]',
  explorerHeader: 'mb-3 flex items-center justify-between gap-3',
  explorerTitle:
    'text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--qn-subtle)]',
  explorerTextButton:
    'rounded-full px-2 py-1 text-xs text-[color:var(--qn-muted)] transition hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  explorerSegment:
    'mb-3 grid grid-cols-4 gap-1 rounded-full bg-[color:var(--qn-search)] p-1',
  explorerSegmentButton:
    'rounded-full px-2 py-1 text-xs font-medium text-[color:var(--qn-muted)] transition hover:text-[color:var(--qn-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--qn-border-strong)]',
  explorerSegmentButtonActive:
    'bg-[color:var(--qn-accent)] text-[color:var(--qn-accent-foreground)] shadow-[var(--qn-accent-shadow)]',
  explorerEmpty: 'rounded-[1rem] bg-[color:var(--qn-search)] px-3 py-4 text-xs leading-5 text-[color:var(--qn-muted)]',
  explorerTagCloud: 'flex flex-wrap gap-2',
  explorerTag:
    'inline-flex items-center gap-1.5 rounded-full bg-[color:var(--qn-chip)] px-2.5 py-1 text-xs text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-ring)] transition hover:bg-[color:var(--qn-accent-soft)] hover:text-[color:var(--qn-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--qn-border-strong)]',
  explorerTagSelected:
    '!bg-[color:var(--qn-accent)] !text-[color:var(--qn-accent-foreground)] ring-[color:var(--qn-border-strong)] shadow-[var(--qn-accent-shadow)]',
  explorerTagCount: 'rounded-full bg-[color:var(--qn-panel-strong)] px-1.5 py-0.5 text-[10px] text-[color:var(--qn-muted)]',
  explorerTagTree: 'grid gap-1',
  explorerTreeNode: 'grid gap-1',
  explorerTreeRow: 'flex items-center justify-between gap-2',
  explorerTreeLabel:
    'min-w-0 truncate rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--qn-text)]',
  explorerTreeCount: 'text-[10px] text-[color:var(--qn-muted)]',
  explorerCalendar: 'grid gap-2',
  explorerCalendarHeader: 'flex items-center justify-between gap-2',
  explorerCalendarNav:
    'flex size-7 items-center justify-center rounded-full text-sm text-[color:var(--qn-muted)] transition hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)]',
  explorerCalendarLabel: 'text-xs font-medium text-[color:var(--qn-text)]',
  explorerWeekdays:
    'grid grid-cols-7 gap-1 text-center text-[9px] font-medium text-[color:var(--qn-subtle)]',
  explorerCalendarGrid: 'grid grid-cols-7 gap-1',
  explorerCalendarCell:
    'flex size-7 items-center justify-center rounded-lg text-[10px] text-[color:var(--qn-text)] transition hover:ring-2 hover:ring-[color:var(--qn-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--qn-border-strong)]',
  explorerCalendarBlank: 'size-7',
  explorerCalendarCellEmpty: 'bg-[color:var(--qn-search)]',
  explorerCalendarCellMinimal: 'bg-[color:var(--qn-accent-soft)]',
  explorerCalendarCellLow: 'bg-[color:var(--qn-selection)]',
  explorerCalendarCellMedium: 'bg-[color:var(--qn-selection-ring)] text-[color:var(--qn-text-strong)]',
  explorerCalendarCellHigh: 'bg-[color:var(--qn-accent)] text-[color:var(--qn-accent-foreground)]',
  explorerCalendarCellSelected:
    '!bg-[color:var(--qn-accent)] !text-[color:var(--qn-accent-foreground)] ring-2 ring-[color:var(--qn-border-strong)] shadow-[var(--qn-accent-shadow)]',
  timeline: 'flex flex-col gap-4',
  groupLabel:
    'sticky top-2 z-10 w-fit rounded-full border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-strong)] px-3 py-1 text-xs font-semibold text-[color:var(--qn-text)] shadow-[var(--qn-shadow-soft)] backdrop-blur-[22px]',
  card:
    'group/card rounded-[1.125rem] border bg-[color:var(--qn-card)] p-4 shadow-none backdrop-blur-[18px] transition-[max-height,background-color,border-color,box-shadow,transform] duration-300 ease-out hover:bg-[color:var(--qn-card-hover)] hover:shadow-[var(--qn-shadow-soft)]',
  cardCollapsed:
    'max-h-[11.25rem] overflow-hidden',
  cardExpanded:
    'quick-note-expanded-card max-h-none overflow-visible border-[color:var(--qn-border-strong)] bg-[color:var(--qn-selection)] ring-1 ring-[color:var(--qn-selection-ring)] hover:translate-y-0',
  cardDefault: 'border-[color:var(--qn-border)]',
  cardPinned: 'border-[color:var(--qn-border-strong)] ring-1 ring-[color:var(--qn-selection-ring)]',
  cardAction:
    'text-[color:var(--qn-muted)] opacity-85 hover:bg-[color:var(--qn-hover)] hover:text-[color:var(--qn-text-strong)] group-hover:opacity-100',
  cardDangerAction:
    'text-[color:var(--qn-muted)] opacity-85 hover:bg-[color:var(--qn-danger-soft)] hover:text-[color:var(--qn-danger)] group-hover:opacity-100',
  pinnedAction:
    'bg-[color:var(--qn-selection)] text-[color:var(--qn-accent-readable)] ring-1 ring-[color:var(--qn-selection-ring)] hover:bg-[color:var(--qn-selection)]',
  cardTitle: 'truncate text-sm font-semibold text-[color:var(--qn-text-strong)]',
  cardBody:
    'mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-[color:var(--qn-text)]',
  cardBodyExpanded:
    'mt-3 text-sm leading-7 text-[color:var(--qn-text)]',
  markdown:
    'quick-note-markdown max-w-none text-[color:var(--qn-text)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:font-medium [&_a]:text-[color:var(--qn-accent-readable)] [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--qn-border-strong)] [&_blockquote]:pl-4 [&_blockquote]:text-[color:var(--qn-muted)] [&_code]:rounded-md [&_code]:bg-[color:var(--qn-search)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[color:var(--qn-text-strong)] [&_h1]:mb-3 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-[color:var(--qn-text-strong)] [&_h2]:mb-3 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-[color:var(--qn-text-strong)] [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[color:var(--qn-text-strong)] [&_hr]:my-5 [&_hr]:border-[color:var(--qn-border)] [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-[1rem] [&_pre]:border [&_pre]:border-[color:var(--qn-border)] [&_pre]:bg-[color:var(--qn-search)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:text-[color:var(--qn-text-strong)] [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[color:var(--qn-border)] [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-[color:var(--qn-border)] [&_th]:bg-[color:var(--qn-panel-muted)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-[color:var(--qn-text-strong)] [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5',
  markdownTableScroll:
    'quick-note-markdown-table-scroll my-4 max-w-full overflow-x-auto rounded-[1rem]',
  markdownPreview: 'leading-7',
  markdownRead: 'leading-8',
  markdownInlinePreview: 'leading-7',
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
    'flex items-center justify-between gap-3 rounded-[1rem] bg-[color:var(--qn-panel-muted)] px-3 py-2',
  trashTitle: 'min-w-0 truncate text-sm text-[color:var(--qn-text-strong)]',
  empty:
    'rounded-[1.5rem] border border-dashed border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] px-6 py-12 text-center shadow-[var(--qn-shadow-soft)] backdrop-blur-[22px]',
  emptyTitle: 'text-base font-semibold text-[color:var(--qn-text-strong)]',
  emptyDescription: 'mt-2 text-sm text-[color:var(--qn-muted)]',
  error:
    'rounded-xl border border-[color:var(--qn-danger-border)] bg-[color:var(--qn-danger-soft)] px-4 py-3 text-sm text-[color:var(--qn-danger)]',
  panelTitle: 'text-sm font-semibold text-[color:var(--qn-text-strong)]',
  motionPanel:
    'quick-note-motion-panel',
  metaGrid: 'grid grid-cols-2 gap-2 rounded-[1.25rem] bg-[color:var(--qn-panel-muted)] p-3',
  metaItem: 'min-w-0 rounded-[0.9rem] px-2 py-1.5',
  metaWide: 'col-span-2 min-w-0 rounded-[0.9rem] px-2 py-1.5',
  metaLabel:
    'block text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--qn-subtle)]',
  metaValue:
    'mt-1 block truncate text-xs font-medium text-[color:var(--qn-text-strong)]',
  metaValueDanger:
    'mt-1 block truncate text-xs font-medium text-[color:var(--qn-danger)]',
  readView:
    'grid min-h-[calc(100svh-12rem)] gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]',
  readArticle:
    'min-w-0 rounded-[2rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-paper)] p-4 shadow-[var(--qn-shadow-soft)] backdrop-blur-[26px] sm:p-7',
  readHeader:
    'mb-5 flex flex-col gap-4 border-b border-[color:var(--qn-border)] pb-4 sm:flex-row sm:items-start sm:justify-between',
  readTitle:
    'mt-2 max-w-3xl text-3xl font-semibold tracking-[-0.045em] text-[color:var(--qn-text-strong)] sm:text-4xl',
  readBody:
    'text-[color:var(--qn-text)]',
  inlineEditorWrap:
    'quick-note-inline-editor grid gap-3 rounded-[1.5rem] border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-panel-muted)] p-3 ring-1 ring-[color:var(--qn-selection-ring)]',
  inlineTextarea:
    'min-h-[18rem] resize-y rounded-[1.25rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-field)] px-4 py-3 text-sm leading-7 text-[color:var(--qn-text-strong)] outline-none transition placeholder:text-[color:var(--qn-placeholder)] focus:border-[color:var(--qn-border-strong)] focus:bg-[color:var(--qn-field-focus)] focus:ring-3 focus:ring-[color:var(--qn-accent-soft)]',
  notice:
    'rounded-[1rem] border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-accent-soft)] px-3 py-2 text-xs text-[color:var(--qn-accent-readable)]',
  readAside:
    'hidden min-w-0 flex-col gap-4 lg:flex',
  asideBlock:
    'rounded-[1.35rem] border border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] p-3 shadow-[var(--qn-shadow-soft)] backdrop-blur-[22px]',
  asideTitle:
    'mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--qn-subtle)]',
  asideRow:
    'flex items-center justify-between gap-3 border-t border-[color:var(--qn-border)] py-2 first:border-t-0 first:pt-0 last:pb-0',
}
