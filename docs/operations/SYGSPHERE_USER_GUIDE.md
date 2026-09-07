# SygSphere messages

## Open SygSphere

Select the branded SygSphere launcher above **Need Help?**. Its badge counts conversations with unread messages, independently of the SygShift notification bell. A compact mobile launcher remains reachable outside the messaging workspace.

## Start and organize conversations

- **New message** opens the company account directory. Search by name or username.
- Choose **Direct message**, **Group message**, or **Team channel**. Groups and channels need a name. Select participants, then create the conversation.
- Reopening a direct conversation with the same person returns the existing conversation instead of creating duplicates.
- **Conversation details → Members** shows participants and presence. Owners can add/remove people or make another participant an owner. Adding a person grants access to the entire conversation history and files; review the confirmation carefully.
- Keep conversations in **Favorites**, mute their alerts, or archive a completed group/channel without deleting its history. At least one owner must remain.

## Send and follow up

- Write a message and select **Send**, or press **Enter**. Use **Shift+Enter** when you want a new line without sending.
- Unsent text is saved on that device for the signed-in account and specific conversation/thread. If device storage is unavailable, keep the page open until sending.
- Failed sends retain the draft. **Retry send** reuses the same identifier to prevent duplicates. Sending is not reported as successful until the database acknowledges it.
- **Reply** opens a real threaded discussion alongside the original message. On a phone the thread takes focus, with a close control to return.
- Use reactions, bookmarks, pins and **Copy message link**. Saved messages and search results open the exact message or thread. URLs, including meeting links, are clickable without fetching private calendar information.
- You can edit/delete your own messages. Edits show a label; deletions leave a marker and retain protected revision evidence.

## Share files

Select the paperclip, choose a file and review **Share file**. Supported files: PDF, PNG/JPEG/WebP, plain text, DOCX and XLSX, up to 25 MB. Unsafe file structures and malware are blocked. Sharing waits for a clean scan; there is no public file URL or unscanned download. File uploads need the page to stay open until complete.

Use the download card or **Conversation details → Files** to retrieve shared files. Download authorization is checked again every time; removing someone from a conversation removes their file access. Files already downloaded to someone's device cannot be recalled.

## Live updates and alerts

Messages, replies and read state refresh through SygSphere's private live channel, with reconnect/focus refresh and a polling fallback. Only visible messages are marked read; opening a conversation does not automatically mark all older history and unopened replies read.

SygSphere has its own messaging sound switch and conversation mute setting. System-wide mute/volume still apply. Browsers may require a click or keypress before allowing sound. Historical messages on initial load are silent, and repeated live events are deduplicated across tabs. No per-message emails or duplicate ticket/system notifications are generated.

This release delivers live alerts while SygShift is open. It does not claim closed-browser push delivery, voice/video calling, Outlook synchronization, external guests or legal-hold/eDiscovery administration. Private conversations are membership-only; being an administrator does not automatically grant access to them.
