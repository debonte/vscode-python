// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { IndentAction, LanguageConfiguration } from 'vscode';

export function getLanguageConfiguration(): LanguageConfiguration {
    return {
        onEnterRules: [
            // continue comments
            {
                beforeText: /^\s*#.*/,
                afterText: /.+$/,
                action: {
                    indentAction: IndentAction.None,
                    appendText: '# ',
                },
            },
        ],
    };
}
