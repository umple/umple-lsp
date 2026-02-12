# Umple LSP for BBEdit

This guide explains how to set up the Umple Language Server with BBEdit 14+.

## Prerequisites

- BBEdit 14 or later (has built-in LSP support)
- Node.js 18+
- Java 11+ (for umplesync.jar)

## Installation

### 1. Install the codeless language module

BBEdit discovers languages via plist files. Save the following as `Umple.plist` in `~/Library/Application Support/BBEdit/Language Modules/`:

```bash
mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Modules
```

Create `Umple.plist` with this content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>BBEditDocumentType</key>
	<string>CodelessLanguageModule</string>
	<key>BBLMLanguageDisplayName</key>
	<string>Umple</string>
	<key>BBLMLanguageCode</key>
	<string>Umpl</string>
	<key>BBLMSuffixMap</key>
	<array>
		<dict>
			<key>BBLMLanguageSuffix</key>
			<string>.ump</string>
		</dict>
	</array>
	<key>BBLMCommentLineDefault</key>
	<string>//</string>
	<key>BBLMCommentBlockOpen</key>
	<string>/*</string>
	<key>BBLMCommentBlockClose</key>
	<string>*/</string>
	<key>BBLMColorsSyntax</key>
	<true/>
	<key>BBLMIsCaseSensitive</key>
	<true/>
	<key>Language Features</key>
	<dict>
		<key>Identifier and Keyword Character Class</key>
		<string>A-Za-z0-9_</string>
	</dict>
	<key>BBLMKeywordList</key>
	<array>
		<string>class</string>
		<string>interface</string>
		<string>trait</string>
		<string>enum</string>
		<string>association</string>
		<string>namespace</string>
		<string>use</string>
		<string>isA</string>
		<string>singleton</string>
		<string>immutable</string>
		<string>abstract</string>
		<string>lazy</string>
		<string>const</string>
		<string>Integer</string>
		<string>String</string>
		<string>Boolean</string>
		<string>Double</string>
		<string>Float</string>
		<string>Date</string>
		<string>Time</string>
	</array>
	<key>BBLMStringCharacter</key>
	<string>"</string>
</dict>
</plist>
```

Restart BBEdit. "Umple" should now appear in **Settings > Languages** and `.ump` files will get basic syntax coloring.

### 2. Install the LSP server from npm

```bash
npm install -g umple-lsp-server
```

Then download umplesync.jar (needed for diagnostics):

```bash
curl -fSL -o "$(npm root -g)/umple-lsp-server/umplesync.jar" \
  https://try.umple.org/scripts/umplesync.jar
```

### 3. Configure the LSP server

1. Open **BBEdit > Settings > Languages**
2. Select **Umple** from the list
3. Go to the **Server** tab
4. Set **Command** to: `umple-lsp-server`
5. Set **Arguments** to: `--stdio`

If BBEdit can't find the command, use the full path instead:

```bash
# Find the full path
which umple-lsp-server
```

Then enter that path (e.g., `/opt/homebrew/bin/umple-lsp-server`) as the **Command**.

### 4. Set initialization options

Create a JSON configuration file so the server can find `umplesync.jar`:

```bash
mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Servers/Configuration
```

Save the following as `~/Library/Application Support/BBEdit/Language Servers/Configuration/Umple.json`:

```json
{
  "initializationOptions": {
    "umpleSyncJarPath": "/path/to/umple-lsp-server/umplesync.jar",
    "umpleSyncPort": 5559
  }
}
```

To find the jar path:

```bash
echo "$(npm root -g)/umple-lsp-server/umplesync.jar"
```

### 5. Restart BBEdit

Close and reopen BBEdit for all changes to take effect.

## Features

- **Syntax highlighting**: Keywords, comments, and strings via the codeless language module
- **Diagnostics**: Real-time error and warning detection
- **Go-to-definition**: Jump to class, attribute, state definitions (command-click or right-click > Go to Definition)
- **Code completion**: Context-aware keyword and symbol completion

## Troubleshooting

### LSP not starting

1. Verify the server runs manually:
   ```bash
   umple-lsp-server --stdio
   ```
   (Type some JSON — if it doesn't crash, the server is working. Press Ctrl+C to exit.)

2. Check BBEdit's log: **Window > Activity**

3. Verify Java is installed (needed for diagnostics): `java -version`

### No diagnostics

1. Ensure `umplesync.jar` exists at the path specified in `Umple.json`
2. Verify Java is available on the system PATH

## Updating

```bash
npm update -g umple-lsp-server
```

Then restart BBEdit.
