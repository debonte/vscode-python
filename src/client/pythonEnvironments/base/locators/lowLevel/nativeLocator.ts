// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import { IDisposable } from '../../../../common/types';
import { ILocator, BasicEnvInfo, IPythonEnvsIterator } from '../../locator';
import { PythonEnvsChangedEvent } from '../../watcher';
import { PythonEnvKind, PythonVersion } from '../../info';
import { Conda } from '../../../common/environmentManagers/conda';
import { traceError, traceInfo } from '../../../../logging';
import type { KnownEnvironmentTools } from '../../../../api/types';
import { setPyEnvBinary } from '../../../common/environmentManagers/pyenv';
import {
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativeGlobalPythonFinder,
    createNativeGlobalPythonFinder,
} from '../common/nativePythonFinder';
import { disposeAll } from '../../../../common/utils/resourceLifecycle';
import { StopWatch } from '../../../../common/utils/stopWatch';
import { Architecture } from '../../../../common/utils/platform';
import { sendTelemetryEvent } from '../../../../telemetry';
import { EventName } from '../../../../telemetry/constants';

function categoryToKind(category: string): PythonEnvKind {
    switch (category.toLowerCase()) {
        case 'conda':
            return PythonEnvKind.Conda;
        case 'system':
        case 'homebrew':
        case 'windowsregistry':
            return PythonEnvKind.System;
        case 'pyenv':
            return PythonEnvKind.Pyenv;
        case 'pipenv':
            return PythonEnvKind.Pipenv;
        case 'pyenvvirtualenv':
            return PythonEnvKind.VirtualEnv;
        case 'virtualenvwrapper':
            return PythonEnvKind.VirtualEnvWrapper;
        case 'windowsstore':
            return PythonEnvKind.MicrosoftStore;
        default: {
            traceError(`Unknown Python Environment category '${category}' from Native Locator.`);
            return PythonEnvKind.Unknown;
        }
    }
}

function toolToKnownEnvironmentTool(tool: string): KnownEnvironmentTools {
    switch (tool.toLowerCase()) {
        case 'conda':
            return 'Conda';
        case 'pyenv':
            return 'Pyenv';
        default: {
            traceError(`Unknown Python Tool '${tool}' from Native Locator.`);
            return 'Unknown';
        }
    }
}

function parseVersion(version?: string): PythonVersion | undefined {
    if (!version) {
        return undefined;
    }

    try {
        const [major, minor, micro] = version.split('.').map((v) => parseInt(v, 10));
        return {
            major: typeof major === 'number' ? major : -1,
            minor: typeof minor === 'number' ? minor : -1,
            micro: typeof micro === 'number' ? micro : -1,
            sysVersion: version,
        };
    } catch {
        return undefined;
    }
}

export class NativeLocator implements ILocator<BasicEnvInfo>, IDisposable {
    public readonly providerId: string = 'native-locator';

    private readonly onChangedEmitter = new EventEmitter<PythonEnvsChangedEvent>();

    private readonly disposables: IDisposable[] = [];

    private readonly finder: NativeGlobalPythonFinder;

    constructor() {
        this.onChanged = this.onChangedEmitter.event;
        this.finder = createNativeGlobalPythonFinder();
        this.disposables.push(this.onChangedEmitter, this.finder);
    }

    public readonly onChanged: Event<PythonEnvsChangedEvent>;

    public async dispose(): Promise<void> {
        this.disposables.forEach((d) => d.dispose());
        return Promise.resolve();
    }

    public iterEnvs(): IPythonEnvsIterator<BasicEnvInfo> {
        const stopWatch = new StopWatch();
        traceInfo('Searching for Python environments using Native Locator');
        const promise = this.finder.startSearch();
        const envs: BasicEnvInfo[] = [];
        const disposables: IDisposable[] = [];
        const disposable = new Disposable(() => disposeAll(disposables));
        this.disposables.push(disposable);
        promise.finally(() => disposable.dispose());
        let environmentsWithoutPython = 0;
        disposables.push(
            this.finder.onDidFindPythonEnvironment((data: NativeEnvInfo) => {
                // TODO: What if executable is undefined?
                if (data.pythonExecutablePath) {
                    const arch = (data.arch || '').toLowerCase();
                    envs.push({
                        kind: categoryToKind(data.category),
                        executablePath: data.pythonExecutablePath,
                        envPath: data.envPath,
                        version: parseVersion(data.version),
                        name: data.name === '' ? undefined : data.name,
                        displayName: data.displayName,
                        pythonRunCommand: data.pythonRunCommand,
                        searchLocation: data.projectPath ? Uri.file(data.projectPath) : undefined,
                        identifiedUsingNativeLocator: true,
                        arch:
                            // eslint-disable-next-line no-nested-ternary
                            arch === 'x64' ? Architecture.x64 : arch === 'x86' ? Architecture.x86 : undefined,
                        ctime: data.creationTime,
                        mtime: data.modifiedTime,
                    });
                } else {
                    environmentsWithoutPython += 1;
                }
            }),
            this.finder.onDidFindEnvironmentManager((data: NativeEnvManagerInfo) => {
                switch (toolToKnownEnvironmentTool(data.tool)) {
                    case 'Conda': {
                        Conda.setConda(data.executablePath);
                        break;
                    }
                    case 'Pyenv': {
                        setPyEnvBinary(data.executablePath);
                        break;
                    }
                    default: {
                        break;
                    }
                }
            }),
        );

        const iterator = async function* (): IPythonEnvsIterator<BasicEnvInfo> {
            // When this promise is complete, we know that the search is complete.
            await promise;
            traceInfo(
                `Finished searching for Python environments using Native Locator: ${stopWatch.elapsedTime} milliseconds`,
            );
            yield* envs;
            sendTelemetry(envs, environmentsWithoutPython, stopWatch);
            traceInfo(
                `Finished yielding Python environments using Native Locator: ${stopWatch.elapsedTime} milliseconds`,
            );
        };

        return iterator();
    }
}

function sendTelemetry(envs: BasicEnvInfo[], environmentsWithoutPython: number, stopWatch: StopWatch) {
    const activeStateEnvs = envs.filter((e) => e.kind === PythonEnvKind.ActiveState).length;
    const condaEnvs = envs.filter((e) => e.kind === PythonEnvKind.Conda).length;
    const customEnvs = envs.filter((e) => e.kind === PythonEnvKind.Custom).length;
    const hatchEnvs = envs.filter((e) => e.kind === PythonEnvKind.Hatch).length;
    const microsoftStoreEnvs = envs.filter((e) => e.kind === PythonEnvKind.MicrosoftStore).length;
    const otherGlobalEnvs = envs.filter((e) => e.kind === PythonEnvKind.OtherGlobal).length;
    const otherVirtualEnvs = envs.filter((e) => e.kind === PythonEnvKind.OtherVirtual).length;
    const pipEnvEnvs = envs.filter((e) => e.kind === PythonEnvKind.Pipenv).length;
    const poetryEnvs = envs.filter((e) => e.kind === PythonEnvKind.Poetry).length;
    const pyenvEnvs = envs.filter((e) => e.kind === PythonEnvKind.Pyenv).length;
    const systemEnvs = envs.filter((e) => e.kind === PythonEnvKind.System).length;
    const unknownEnvs = envs.filter((e) => e.kind === PythonEnvKind.Unknown).length;
    const venvEnvs = envs.filter((e) => e.kind === PythonEnvKind.Venv).length;
    const virtualEnvEnvs = envs.filter((e) => e.kind === PythonEnvKind.VirtualEnv).length;
    const virtualEnvWrapperEnvs = envs.filter((e) => e.kind === PythonEnvKind.VirtualEnvWrapper).length;

    // Intent is to capture time taken for discovery of all envs to complete the first time.
    sendTelemetryEvent(EventName.PYTHON_INTERPRETER_DISCOVERY, stopWatch.elapsedTime, {
        interpreters: envs.length,
        environmentsWithoutPython,
        activeStateEnvs,
        condaEnvs,
        customEnvs,
        hatchEnvs,
        microsoftStoreEnvs,
        otherGlobalEnvs,
        otherVirtualEnvs,
        pipEnvEnvs,
        poetryEnvs,
        pyenvEnvs,
        systemEnvs,
        unknownEnvs,
        venvEnvs,
        virtualEnvEnvs,
        virtualEnvWrapperEnvs,
    });
}
