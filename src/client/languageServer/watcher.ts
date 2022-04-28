// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { inject, injectable } from 'inversify';
import { ConfigurationChangeEvent, Uri, WorkspaceFoldersChangeEvent } from 'vscode';
import { LanguageServerChangeHandler } from '../activation/common/languageServerChangeHandler';
import {
    IExtensionActivationService,
    ILanguageServer,
    ILanguageServerCache,
    ILanguageServerOutputChannel,
    LanguageServerType,
} from '../activation/types';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../common/application/types';
import { IFileSystem } from '../common/platform/types';
import {
    IConfigurationService,
    IDisposableRegistry,
    IExperimentService,
    IExtensions,
    IInterpreterPathService,
    InterpreterConfigurationScope,
    Resource,
} from '../common/types';
import { LanguageService } from '../common/utils/localize';
import { IEnvironmentVariablesProvider } from '../common/variables/types';
import { IInterpreterHelper, IInterpreterService } from '../interpreter/contracts';
import { IServiceContainer } from '../ioc/types';
import { traceLog } from '../logging';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { JediLSExtensionManager } from './jediLSExtensionManager';
import { NoneLSExtensionManager } from './noneLSExtensionManager';
import { PylanceLSExtensionManager } from './pylanceLSExtensionManager';
import { ILanguageServerExtensionManager, ILanguageServerWatcher } from './types';
import { LspNotebooksExperiment } from '../activation/node/lspNotebooksExperiment';
import { JupyterExtensionIntegration } from '../jupyter/jupyterIntegration';

@injectable()
/**
 * The Language Server Watcher class implements the ILanguageServerWatcher interface, which is the one-stop shop for language server activation.
 *
 * It also implements the ILanguageServerCache interface needed by our Jupyter support.
 */
export class LanguageServerWatcher
    implements IExtensionActivationService, ILanguageServerWatcher, ILanguageServerCache {
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: true, virtualWorkspace: true };

    languageServerExtensionManager: ILanguageServerExtensionManager | undefined;

    languageServerType: LanguageServerType;

    private workspaceInterpreters: Map<string, PythonEnvironment | undefined>;

    // In a multiroot workspace scenario we may have multiple language servers running:
    // When using Jedi, there will be one language server per workspace folder.
    // When using Pylance, there will only be one language server for the project.
    private workspaceLanguageServers: Map<string, ILanguageServerExtensionManager | undefined>;

    private languageServerChangeHandler: LanguageServerChangeHandler;

    constructor(
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(ILanguageServerOutputChannel) private readonly lsOutputChannel: ILanguageServerOutputChannel,
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(IExperimentService) private readonly experimentService: IExperimentService,
        @inject(IInterpreterHelper) private readonly interpreterHelper: IInterpreterHelper,
        @inject(IInterpreterPathService) private readonly interpreterPathService: IInterpreterPathService,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IEnvironmentVariablesProvider) private readonly environmentService: IEnvironmentVariablesProvider,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IApplicationShell) readonly applicationShell: IApplicationShell,
        @inject(LspNotebooksExperiment) private readonly lspNotebooksExperiment: LspNotebooksExperiment,
        @inject(JupyterExtensionIntegration) private readonly jupyterExtensionIntegration: JupyterExtensionIntegration,
        @inject(IDisposableRegistry) readonly disposables: IDisposableRegistry,
    ) {
        this.workspaceInterpreters = new Map();
        this.workspaceLanguageServers = new Map();
        this.languageServerType = this.configurationService.getSettings().languageServer;

        disposables.push(this.workspaceService.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this)));

        disposables.push(
            this.workspaceService.onDidChangeWorkspaceFolders(this.onDidChangeWorkspaceFolders.bind(this)),
        );

        if (this.workspaceService.isTrusted) {
            disposables.push(this.interpreterPathService.onDidChange(this.onDidChangeInterpreter.bind(this)));
        }

        this.languageServerChangeHandler = new LanguageServerChangeHandler(
            this.languageServerType,
            this.extensions,
            this.applicationShell,
            this.commandManager,
            this.workspaceService,
            this.configurationService,
        );
        disposables.push(this.languageServerChangeHandler);

        disposables.push(
            extensions.onDidChange(async () => {
                await this.extensionsChangeHandler();
            }),
        );
    }

    // IExtensionActivationService

    public async activate(resource?: Resource): Promise<void> {
        await this.startLanguageServer(this.languageServerType, resource);
    }

    // ILanguageServerWatcher
    public async startLanguageServer(languageServerType: LanguageServerType, resource?: Resource): Promise<void> {
        await this.startAndGetLanguageServer(languageServerType, resource);
    }

    private async startAndGetLanguageServer(
        languageServerType: LanguageServerType,
        resource?: Resource,
    ): Promise<ILanguageServerExtensionManager> {
        const lsResource = this.getWorkspaceUri(resource);
        const currentInterpreter = this.workspaceInterpreters.get(lsResource.fsPath);
        const interpreter = await this.interpreterService?.getActiveInterpreter(resource);

        // Destroy the old language server if it's different.
        if (currentInterpreter && interpreter !== currentInterpreter) {
            this.stopLanguageServer(lsResource);
        }

        // If the interpreter is Python 2 and the LS setting is explicitly set to Jedi, turn it off.
        // If set to Default, use Pylance.
        let serverType = languageServerType;
        if (interpreter && (interpreter.version?.major ?? 0) < 3) {
            if (serverType === LanguageServerType.Jedi) {
                serverType = LanguageServerType.None;
            } else if (this.getCurrentLanguageServerTypeIsDefault()) {
                serverType = LanguageServerType.Node;
            }
        }

        if (
            !this.workspaceService.isTrusted &&
            serverType !== LanguageServerType.Node &&
            serverType !== LanguageServerType.None
        ) {
            traceLog(LanguageService.untrustedWorkspaceMessage());
            serverType = LanguageServerType.None;
        }

        // If the language server type is Pylance or None,
        // We only need to instantiate the language server once, even in multiroot workspace scenarios,
        // so we only need one language server extension manager.
        const key = this.getWorkspaceKey(resource, serverType);
        const languageServer = this.workspaceLanguageServers.get(key);
        if ((serverType === LanguageServerType.Node || serverType === LanguageServerType.None) && languageServer) {
            return languageServer;
        }

        // Instantiate the language server extension manager.
        const languageServerExtensionManager = this.createLanguageServer(serverType);

        if (languageServerExtensionManager.canStartLanguageServer()) {
            // Start the language server.
            await languageServerExtensionManager.startLanguageServer(lsResource, interpreter);

            logStartup(languageServerType, lsResource);
            this.languageServerType = languageServerType;
            this.workspaceInterpreters.set(lsResource.fsPath, interpreter);
        } else {
            await languageServerExtensionManager.languageServerNotAvailable();
        }

        this.workspaceLanguageServers.set(key, languageServerExtensionManager);

        return languageServerExtensionManager;
    }

    // ILanguageServerCache

    public async get(resource?: Resource): Promise<ILanguageServer> {
        const key = this.getWorkspaceKey(resource, this.languageServerType);
        let languageServerExtensionManager = this.workspaceLanguageServers.get(key);

        if (!languageServerExtensionManager) {
            languageServerExtensionManager = await this.startAndGetLanguageServer(this.languageServerType, resource);
        }

        return Promise.resolve(languageServerExtensionManager.get());
    }

    // Private methods

    private stopLanguageServer(resource?: Resource): void {
        const key = this.getWorkspaceKey(resource, this.languageServerType);
        const languageServerExtensionManager = this.workspaceLanguageServers.get(key);

        if (languageServerExtensionManager) {
            languageServerExtensionManager.stopLanguageServer();
            languageServerExtensionManager.dispose();
            this.workspaceLanguageServers.delete(key);
        }
    }

    private createLanguageServer(languageServerType: LanguageServerType): ILanguageServerExtensionManager {
        switch (languageServerType) {
            case LanguageServerType.Jedi:
                this.languageServerExtensionManager = new JediLSExtensionManager(
                    this.serviceContainer,
                    this.lsOutputChannel,
                    this.experimentService,
                    this.workspaceService,
                    this.configurationService,
                    this.interpreterPathService,
                    this.interpreterService,
                    this.environmentService,
                    this.commandManager,
                );
                break;
            case LanguageServerType.Node:
                this.languageServerExtensionManager = new PylanceLSExtensionManager(
                    this.serviceContainer,
                    this.lsOutputChannel,
                    this.experimentService,
                    this.workspaceService,
                    this.configurationService,
                    this.interpreterPathService,
                    this.interpreterService,
                    this.environmentService,
                    this.commandManager,
                    this.fileSystem,
                    this.extensions,
                    this.applicationShell,
                    this.lspNotebooksExperiment,
                    this.jupyterExtensionIntegration,
                );
                break;
            case LanguageServerType.None:
            default:
                this.languageServerExtensionManager = new NoneLSExtensionManager();
                break;
        }

        return this.languageServerExtensionManager;
    }

    private async refreshLanguageServer(resource?: Resource): Promise<void> {
        const lsResource = this.getWorkspaceUri(resource);
        const languageServerType = this.configurationService.getSettings(lsResource).languageServer;

        if (languageServerType !== this.languageServerType) {
            this.stopLanguageServer(resource);
            await this.startLanguageServer(languageServerType, lsResource);
        }
    }

    private getCurrentLanguageServerTypeIsDefault(): boolean {
        return this.configurationService.getSettings().languageServerIsDefault;
    }

    // Watch for settings changes.
    private async onDidChangeConfiguration(event: ConfigurationChangeEvent): Promise<void> {
        const workspacesUris = this.workspaceService.workspaceFolders?.map((workspace) => workspace.uri) ?? [];

        workspacesUris.forEach(async (resource) => {
            if (event.affectsConfiguration(`python.languageServer`, resource)) {
                await this.refreshLanguageServer(resource);
            }
        });
    }

    // Watch for interpreter changes.
    private async onDidChangeInterpreter(event: InterpreterConfigurationScope): Promise<void> {
        // Reactivate the language server (if in a multiroot workspace scenario, pick the correct one).
        return this.activate(event.uri);
    }

    // Watch for extension changes.
    private async extensionsChangeHandler(): Promise<void> {
        const languageServerType = this.configurationService.getSettings().languageServer;

        if (languageServerType !== this.languageServerType) {
            await this.refreshLanguageServer();
        }
    }

    // Watch for workspace folder changes.
    private async onDidChangeWorkspaceFolders(event: WorkspaceFoldersChangeEvent): Promise<void> {
        // Since Jedi is the only language server type where we instantiate multiple language servers,
        // Make sure to dispose of them only in that scenario.
        if (event.removed.length && this.languageServerType === LanguageServerType.Jedi) {
            event.removed.forEach((workspace) => {
                this.stopLanguageServer(workspace.uri);
            });
        }
    }

    // Get the workspace Uri for the given resource, in order to query this.workspaceInterpreters and this.workspaceLanguageServers.
    private getWorkspaceUri(resource?: Resource): Uri {
        let uri;

        if (resource) {
            uri = this.workspaceService.getWorkspaceFolder(resource)?.uri;
        } else {
            uri = this.interpreterHelper.getActiveWorkspaceUri(resource)?.folderUri;
        }

        return uri ?? Uri.parse('default');
    }

    // Get the key used to identify which language server extension manager is associated to which workspace.
    // When using Pylance or having no LS enabled, we return a static key since there should only be one LS extension manager for these LS types.
    private getWorkspaceKey(resource: Resource | undefined, languageServerType: LanguageServerType): string {
        switch (languageServerType) {
            case LanguageServerType.Node:
                return 'Pylance';
            case LanguageServerType.None:
                return 'None';
            default:
                return this.getWorkspaceUri(resource).fsPath;
        }
    }
}

function logStartup(languageServerType: LanguageServerType, resource: Uri): void {
    let outputLine;
    const basename = path.basename(resource.fsPath);

    switch (languageServerType) {
        case LanguageServerType.Jedi:
            outputLine = LanguageService.startingJedi().format(basename);
            break;
        case LanguageServerType.Node:
            outputLine = LanguageService.startingPylance();
            break;
        case LanguageServerType.None:
            outputLine = LanguageService.startingNone();
            break;
        default:
            throw new Error(`Unknown language server type: ${languageServerType}`);
    }
    traceLog(outputLine);
}
