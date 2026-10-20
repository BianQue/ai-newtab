/** Replaceable presentation policy; data and authorization contracts live separately. */
export const MEETING_PRESENTATION_RULES = `## Meeting presentation

The meeting region follows the user's page layout, typography and colors.
Render successful empty lists and unavailable/auth-required states. Keep existing
rows visible during updates; before the first snapshot use a quiet placeholder.
Show a connect action only when authorization is required.

Do not show a refresh button, loading banner, toast, spinner or prominent stale warning.
Use a small static status dot next to the meeting heading (neutral while updating,
green when current, amber on stale/error), with a descriptive title and aria-label
including fetchedAt and any error. Do not use animation or a live announcement.

By default show at most three lines of each original summary using CSS line clamping,
not text truncation. Provide a keyboard-accessible expand/collapse control with
aria-expanded for each available summary. When expanded, show the complete original
in a scrollable area with maxHeight: "min(360px, 50vh)" and overflowY: "auto".
Keep expansion keyed by meeting id across data refreshes. The seven-day summaries
list must have maxHeight: 480px and overflowY: "auto" so many meetings cannot
dominate the page. Allow long text to wrap on mobile.`;
