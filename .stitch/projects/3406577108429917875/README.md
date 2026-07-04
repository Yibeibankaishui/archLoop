# Stitch Export: archLoop Hub Control Plane

Source project:

- URL: https://stitch.withgoogle.com/projects/3406577108429917875?pli=1
- Project ID: `3406577108429917875`
- Name: `projects/3406577108429917875`
- Title: `archLoop Hub Control Plane`
- Visibility: `PRIVATE`
- Owner role: `OWNER`
- Origin: `STITCH`
- Project type: `TEXT_TO_UI_PRO`
- Device type: `DESKTOP`
- Created: `2026-06-23T10:58:06.503875Z`
- Updated: `2026-06-23T10:59:30.486065Z`

Downloaded/recorded materials:

- `project.json`: project-level metadata returned by the Stitch MCP.
- `screens.json`: screen lookup result. `list_screens` returned no screens for this project.
- `DESIGN.md`: design system markdown from `designTheme.designMd`.
- `design-system.json`: design system metadata returned by `list_design_systems`.
- `thumbnail.png`: project thumbnail downloaded from `thumbnailScreenshot.downloadUrl`, if present.

Tool availability checked:

- Available Stitch skills include `stitch-design:stitch::manage-design-system`
  and `stitch-build:react:components`.
- Available Stitch MCP tools include `get_project`, `list_projects`,
  `list_design_systems`, `list_screens`, and `get_screen`.
- No `read_url_content`/asset-download MCP tool was exposed in this session, so
  binary asset download uses the `downloadUrl` from MCP metadata.
