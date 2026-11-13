import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'tsup';

// テスト用に src/*.ts を entry ごとに ESM へ書き出して import する共通処理。
// 書き出し先は build/ 下の一時ディレクトリで、テスト終了時に消す。
// entry は splitting なしで個別に bundle されるので、entry をまたいだ
// クラスの同一性（instanceof 等）には頼らないこと。
export async function buildSources(prefix, entry) {
    mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
    const outDir = mkdtempSync(fileURLToPath(new URL(`../build/${prefix}-`, import.meta.url)));
    after(() => rmSync(outDir, { recursive: true, force: true }));
    await build({
        entry,
        outDir, format: ['esm'], platform: 'node', splitting: false,
        dts: false, sourcemap: false, config: false, silent: true,
        external: ['@mapconductor/js-sdk-core'],
    });
    const modules = {};
    for (const name of Object.keys(entry)) {
        modules[name] = await import(pathToFileURL(resolve(outDir, `${name}.mjs`)));
    }
    return modules;
}
