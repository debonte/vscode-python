// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { inject, injectable } from 'inversify';
import { WorkspaceFolder } from 'vscode';
import { DocumentFilter } from 'vscode-languageserver-protocol';
import { IWorkspaceService } from '../../common/application/types';

import { LanguageServerAnalysisOptionsBase } from '../common/analysisOptions';
import { ILanguageServerOutputChannel } from '../types';
import { LspNotebooksExperiment } from './lspNotebooksExperiment';

@injectable()
export class NodeLanguageServerAnalysisOptions extends LanguageServerAnalysisOptionsBase {
    constructor(
        @inject(ILanguageServerOutputChannel) lsOutputChannel: ILanguageServerOutputChannel,
        @inject(IWorkspaceService) workspace: IWorkspaceService,
        @inject(LspNotebooksExperiment) private readonly lspNotebooksExperiment: LspNotebooksExperiment,
    ) {
        super(lsOutputChannel, workspace);
    }

    protected async getInitializationOptions() {
        return {
            experimentationSupport: true,
            trustedWorkspaceSupport: true,
            lspNotebooksSupport: this.lspNotebooksExperiment.isInNotebooksExperiment() == true,
        };
    }

    protected async getDocumentFilters(_workspaceFolder?: WorkspaceFolder): Promise<DocumentFilter[]> {
        let filters = await super.getDocumentFilters(_workspaceFolder);

        if (this.lspNotebooksExperiment.isInNotebooksExperiment() == true) {
            return [
                ...filters,
                {
                    notebookDocument: { notebookType: 'jupyter-notebook', pattern: '**/*.ipynb' },
                    cellLanguage: 'python',
                },
            ];
        }

        return filters;
    }
}
