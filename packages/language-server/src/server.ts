/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { URI, Utils } from 'vscode-uri';
import { readFileSync } from 'fs';
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  MarkupContent,
  FileEvent,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import ChakraDependencyTracker from './ChakraDependencyTracker';
import { isJs, isTs, mapPositionToLoc, readUriFiles } from './utils';
import ChakraCodeAnalyzer from './ChakraCodeAnalyzer';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Keeps track of chakra dependency in workspace projects
const chakraDependencyTracker = new ChakraDependencyTracker();

// Parses source code to AST, caching
const chakraCodeAnalyzer = new ChakraCodeAnalyzer();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize(async (params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!capabilities.workspace?.configuration;
  hasWorkspaceFolderCapability = !!capabilities.workspace?.workspaceFolders;
  hasDiagnosticRelatedInformationCapability = !!capabilities.textDocument?.publishDiagnostics
    ?.relatedInformation;

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
      hoverProvider: true,
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  if (params.workspaceFolders) {
    await chakraDependencyTracker.setInitialHasChakraStates(params.workspaceFolders);
  }

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.chakraThemeLanguageServer || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'chakraThemeLanguageServer',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  console.log(change.document, 'DOCUMENT');

  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const text = textDocument.getText();
  const pattern = /\b[A-Z]{2,}\b/g;
  let m: RegExpExecArray | null;

  let problems = 0;
  const diagnostics: Diagnostic[] = [];
  while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
    problems++;
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: textDocument.positionAt(m.index),
        end: textDocument.positionAt(m.index + m[0].length),
      },
      message: `${m[0]} is all uppercase.`,
      source: 'ex',
    };
    if (hasDiagnosticRelatedInformationCapability) {
      diagnostic.relatedInformation = [
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Spelling matters',
        },
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Particularly for names',
        },
      ];
    }
    diagnostics.push(diagnostic);
  }

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(async ({ changes }) => {
  const jsonFileChanges: FileEvent[] = [];
  const sourceCodeFileChanges: FileEvent[] = [];
  for (const c of changes) {
    const extName = Utils.extname(URI.parse(c.uri));
    if (isJs(extName) || isTs(extName)) {
      sourceCodeFileChanges.push(c);
    } else if (extName === '.json') {
      jsonFileChanges.push(c);
    }
  }

  if (jsonFileChanges.length) {
    chakraDependencyTracker.updateHasChakraStatesFromFileChanges(jsonFileChanges);
  }
  if (sourceCodeFileChanges.length) {
    const readSourceFileResults = await readUriFiles(
      sourceCodeFileChanges.map((change) => change.uri),
      'utf-8'
    );
    readSourceFileResults.successes.forEach((readResult, index) => {
      chakraCodeAnalyzer.parse({
        uri: sourceCodeFileChanges[index].uri,
        code: readResult.value,
        shouldInvalidate: true,
      });
    });
  }
});

connection.onHover((params) => {
  const hasChakra = chakraDependencyTracker.findHasChakraByUri(params.textDocument.uri);
  if (!hasChakra) {
    return null;
  }

  const parsedDocumentUri = URI.parse(params.textDocument.uri);
  const extName = Utils.extname(parsedDocumentUri);
  if (!isTs(extName) || !isJs(extName)) {
    return;
  }

  console.log(params.position, 'HOVER POSITION');

  let code: string | null = null;
  try {
    code = readFileSync(parsedDocumentUri.fsPath, 'utf-8');
  } catch (error) {
    console.error(error);
    return null;
  }
  const parsedResult = chakraCodeAnalyzer.parse({ uri: params.textDocument.uri, code });
  if (!parsedResult) {
    return null;
  }

  const hoverLoc = mapPositionToLoc(params.position);

  const doc: MarkupContent = {
    kind: 'markdown',
    value: ['# HAS CHAKRA!', '### PARSE SOMETHING'].join('\n'),
  };

  return {
    contents: doc,
  };
});

// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
  // The pass parameter contains the position of the text document in
  // which code complete got requested. For the example we ignore this
  // info and always provide the same completion items.
  return [
    {
      label: 'TypeScript',
      kind: CompletionItemKind.Text,
      data: 1,
    },
    {
      label: 'JavaScript',
      kind: CompletionItemKind.Text,
      data: 2,
    },
  ];
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = 'TypeScript details';
      item.documentation = 'TypeScript documentation';
    } else if (item.data === 2) {
      item.detail = 'JavaScript details';
      item.documentation = 'JavaScript documentation';
    }
    return item;
  }
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
