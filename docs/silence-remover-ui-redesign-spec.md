# Silence Detector UI redesign specification

## 1. Purpose

Redesign the Silence Detector page around the attached dark, editing-workspace reference. Keep the existing media probing, silence analysis, waveform preview, settings, and FCP7 XML export behavior. Add file drag-and-drop as a first-class way to load media, backed by the local agent.

This is a design and implementation specification. It does not authorize changing the application in this document task.

## 2. Product goals

- Make the waveform and analysis state the visual focus of the page.
- Keep analysis settings, media information, and the primary actions easy to reach.
- Allow users to load a local audio/video file by dropping it into the workspace or using the existing file picker.
- Preserve the current analysis and export rules, localization, agent connection status, and advertising placements.
- Make clear that files are processed by the local agent on the user's computer.

## 3. Reference interpretation

Use the attached HTML as a visual reference for its compact header, dark theme, settings sidebar, large waveform workspace, drop target, and anchored actions. Treat its sample waveform, sample path, sample metadata, and sample analysis results as mock content only. Do not copy its fake values or its sample-only JavaScript behavior into the product.

## 4. Existing behavior to preserve

The current page is `web-ui/tools/silence-remover/`. Its browser client calls the local agent for file selection, media probing, waveform peak generation, silence analysis, and export state. These workflows currently use a local `video_path`; waveform, analysis, and export state are associated with that path.

Preserve the following user-visible behavior and rules:

- Agent connection and readiness status, including disconnected, installing, busy, and error states.
- Existing browse action and local-agent file picker.
- Automatic media metadata probing, including FPS and audio summary values when available.
- User controls for FPS, sensitivity, minimum silence duration, speech padding, and remove-silence behavior.
- Waveform loading, zoom, silence highlighting, and analysis progress/results.
- Existing validation and stale-result invalidation when the selected media or analysis settings change.
- FCP7 XML export gating and current download page handoff.
- Existing localization, accessibility, responsive behavior, and the current advertising slots and policy constraints.

## 5. Proposed desktop layout

At wide desktop sizes, use a full-height application shell with a compact header and a two-column workspace. Keep the document scroll available for the guide and any content below the editor; do not force the entire page into a clipped 100vh layout.

### Header

- Left: product identity and “Silence Detector” title.
- Right: agent connection/readiness status and dashboard navigation.
- Keep the status readable and available while the user works. It must not imply that analysis is available when the agent is disconnected or unprepared.

### Main workspace

- Left inspector: approximately 320–360 px at desktop widths, with its own scroll when needed.
- Right work area: flexible width, prioritizing the waveform.
- At narrow widths, stack the inspector and waveform into a single column; keep primary actions accessible without horizontal scrolling.

### Left inspector

Order the controls as follows:

1. **Media** — selected filename, optional path details, browse button, and replace/remove action as appropriate. Show a drop affordance here only if it does not compete with the main waveform drop target.
2. **Analysis settings** — FPS, average volume/read-only values, recommended sensitivity, editable sensitivity, padding, and minimum silence duration. Retain existing units, values, validation, and behavior.
3. **Media summary** — duration, volume/dynamic range, native FPS, sample rate, and analysis summary when present.
4. **Action dock** — remove-silence option, primary Analyze action, and XML export action. On desktop this may stick to the bottom of the sidebar; on small screens it must remain in normal flow and must not cover controls.

### Right waveform workspace

- Header: waveform title, current analysis summary when available, legend, and existing zoom controls.
- Main canvas: use the existing waveform rendering and silence overlays. Do not substitute a decorative/sample waveform.
- Empty state: explain that the user can drop an audio/video file or choose Browse.
- Drag-over state: visibly highlight the drop target and show a concise “Drop to load” instruction.
- Loaded state: show the actual selected file and waveform-loading or ready state.
- Keep waveform interaction (zoom, scroll/pan, and silence preview) operable and visually distinct from file loading.

### Advertising and guide content

- Preserve the existing editor ad slots, their placement, reserved layout space, and applicable ad visibility behavior. The reference's two side-by-side 728×90 ad placeholders are not a requirement to add new slots.
- Keep the explanatory guide below the editing workspace. It should not crowd the primary analysis workflow.

## 6. Drag-and-drop behavior

### Interaction

- Accept one file at a time for the first release. Multiple-file drops show a clear message and do not silently choose an arbitrary file.
- Accept the same supported audio/video formats as the current agent picker and analysis pipeline. Keep the supported list in sync rather than maintaining a UI-only list.
- Prevent the browser's default navigation behavior for file drops over the application.
- Dropping outside the designated target must not unexpectedly replace the current media.
- A valid drop starts transfer to the local agent, then follows the existing probe → waveform → analysis → export workflow. Dropping a file does not automatically run silence analysis unless that is separately approved as a product behavior.
- Browse remains available as an equivalent alternative.
- While transfer, probe, or waveform generation is active, show the correct stage and prevent accidental duplicate submissions. Provide cancellation where the underlying request can be safely cancelled.
- On replacement, invalidate prior path-bound waveform, analysis, and export state using the same rules as selecting a different path through Browse.

### Local-agent integration

The browser cannot reliably supply the absolute local filesystem path for a dropped file. The browser must send the dropped `File` contents to the local agent over the existing local bridge. The agent should validate the request, stage the file in an agent-managed temporary location, and return an opaque upload/media identifier or a canonical local path for subsequent existing operations. The UI must not invent a path from `File.name` or rely on non-standard browser `File.path` properties.

Prefer a temporary-file handoff compatible with the existing path-based probe, waveform, and analysis endpoints. The design should specify and implement:

- A dedicated local-agent upload endpoint using a streaming raw-file request. The implementation uses `POST /api/tools/silence-remover/drop-upload`.
- File type and size validation, with a 50 GB maximum exposed as an actionable UI error.
- Safe generated temporary filenames; never use the client-provided filename as a filesystem path.
- Temporary-file lifecycle: remove partial uploads on failure or cancellation, remove replaced drop uploads when possible, and purge completed temporary uploads after 24 hours.
- A bounded upload duration, progress reporting where available, and abort handling.
- A response contract that lets the UI call existing operations without exposing an arbitrary filesystem write capability.
- Local-only transfer to the user's agent; do not route media through the website server or a third-party service.
- Reuse existing agent authentication/origin checks, request size controls, and path validation. The new endpoint must not weaken the agent's current filesystem access boundaries.

If the bridge cannot safely upload large media files, an alternative is a native drop target owned by the local desktop agent that forwards a validated path to the page. That is a separate integration option; browser drag-and-drop alone cannot make the agent observe a path it was never given.

## 7. Visual direction

- Dark charcoal/navy surfaces with clear panel boundaries and restrained cyan/blue accents.
- Use the current app's typography and design tokens where possible; extend shared tokens instead of introducing an isolated palette.
- Reserve bright colors for meaningful states: cyan/blue for active/primary controls, green for ready/success, rose for silence/cut regions, and amber/red for warnings/errors.
- Ensure text, controls, focus rings, and waveform colors remain legible in both supported themes if theme switching is enabled for this tool.
- Use consistent spacing, radii, and control heights. Avoid making the sidebar so dense that labels or help text become unreadable.
- Do not display example file paths, hard-coded metadata, fake silence counts, or fabricated analysis results.

## 8. Required states and messages

| State | UI response |
|---|---|
| No file selected | Empty waveform prompt; Analyze and export remain unavailable according to existing rules. |
| Dragging supported file over target | Highlight target and show drop instruction. |
| Unsupported file | Reject before analysis and explain supported formats. |
| Multiple files dropped | Explain single-file behavior; do not choose one implicitly. |
| Uploading to agent | Show filename, transfer progress if available, and cancellation if supported. |
| Agent disconnected | Preserve connection/install guidance; do not claim upload has started. |
| Probing / waveform generation | Show existing progress treatment and distinguish it from upload progress. |
| Ready, not analyzed | Show actual waveform and metadata; enable analysis only when existing prerequisites pass. |
| Analysis running | Show existing analysis progress and prevent duplicate runs. |
| Analysis complete | Show real silence summary/regions and enable XML export only when current validation passes. |
| Upload/probe/analysis failure | Keep the failure actionable, preserve the selected filename when useful, and avoid leaving stale export enabled. |
| Replace current file | Reset or restore state according to existing path-bound session rules. |

## 9. Accessibility and responsive requirements

- The drop zone must also be usable with Browse and keyboard controls; drag-and-drop cannot be the only input method.
- Use semantic buttons and status/live regions for upload and analysis progress.
- Provide visible keyboard focus and do not communicate drag-over, ready, or error states by color alone.
- Keep controls usable at narrow viewport widths and browser zoom. Avoid horizontal scrolling for the editor controls.
- Maintain reasonable touch target sizes; do not require hover to discover file selection.

## 10. Implementation boundaries

### Frontend

- Restructure `web-ui/tools/silence-remover/index.html` and `style.css` to implement the workspace hierarchy and responsive states.
- Update `script.js` to support drag events, agent upload, state transitions, and reuse of the current probe/waveform/analysis/export flows.
- Keep `waveform-canvas.js` and `waveform-renderer.js` as the source of actual waveform rendering unless implementation review finds a concrete need to change them.
- Keep labels compatible with the existing i18n mechanism; add translation keys for all new states and errors.

### Local agent

- Add the narrowly scoped upload/staging API in the agent router used by the Silence Detector.
- Reuse existing media validation/probe/analysis code after staging rather than duplicating the silence analysis engine.
- Ensure cleanup and error paths are covered, and preserve current path-based endpoints for Browse-selected files and other callers.

## 11. Acceptance criteria

- The page has the new compact, dark, two-column editing-workspace design on desktop and a usable stacked layout on mobile/narrow windows.
- Existing browse-based selection still probes media, loads the real waveform, analyzes silence, and exports XML as before.
- Dropping one supported file transfers it only to the local agent, then loads it through the same media workflow.
- Unsupported and multiple-file drops produce clear feedback and do not navigate away or corrupt the current selection.
- Replacement, failure, cancellation, and agent disconnection leave no stale waveform or export state enabled.
- Temporary uploaded files are cleaned up according to the documented lifecycle.
- No fake sample values or waveform data appear in the production interface.
- Existing ads, guide content, localization, keyboard access, and responsive behavior remain intact.

## 12. Open implementation decisions

These are engineering decisions to settle during implementation, not blockers to the visual design:

- Upload request protocol and chunking strategy for large media files.
- Maximum upload size and supported formats, aligned with current agent capabilities.
- The agent returns a temporary path to keep the existing path-based operations intact.
- Temporary uploads expire after 24 hours; replaced files are removed when possible while preserving files needed by the export handoff.
- Exact responsive breakpoint and whether the sidebar action dock becomes sticky on tablet layouts.
