import {createNativeFullscriptTargetRuntime} from './qualification-target-runtime';
import type {FullscriptTargetBuild} from './qualification-target-loader';
declare const __FULLSCRIPT_API_BUILD__:FullscriptTargetBuild;
export const handler=createNativeFullscriptTargetRuntime(__FULLSCRIPT_API_BUILD__);
