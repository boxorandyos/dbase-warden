# Dbase Warden UI and Theme Guidance

## Objective

Keep the GUI visually and behaviorally identical to Nginx Warden and Mail Warden patterns, while introducing a distinct color theme to identify Dbase Warden instantly.

## UX consistency rules

- Preserve navigation structure and placement conventions
- Reuse interaction patterns for lists, detail pages, forms, and modals
- Keep shared component behavior and spacing rhythm the same
- Maintain similar terminology style where domain meaning overlaps

## Visual differentiation

- Introduce a Dbase-specific brand accent palette
- Keep accessibility contrast thresholds equal to sibling products
- Reuse typography, sizing, and control densities
- Avoid structural layout changes for theming-only differences

## Suggested color direction (initial proposal)

- Primary accent: slate/indigo family
- Secondary accent: teal family
- Status palette: inherit existing semantic success/warn/error mapping

## Implementation guidance

1. Use tokenized color variables instead of component-level hardcoding
2. Theme overrides should be isolated in a dedicated Dbase theme package/file
3. Shared component library should remain unchanged when possible
4. Validate theme parity using side-by-side screenshot checks against sibling products
