<!-- Portions ported from libre-manga-translator src/lib/components/settings/SiteRulesSettings.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader. -->
<script lang="ts">
  import { FileCode, Play, Plus, Trash2 } from "lucide-svelte";

  let {
    customRules = $bindable([]),
    hostname = "",
    title = "",
    path = "",
  }: {
    customRules: SiteRule[];
    hostname?: string;
    title?: string;
    path?: string;
  } = $props();

  let editingRule = $state<SiteRule | null>(null);
  let testResult = $state<any>(null);
  let isTesting = $state(false);

  function addRule() {
    editingRule = {
      id: crypto.randomUUID(),
      domain: hostname || window.location.hostname,
      seriesName: {
        regex: "",
        source: "title",
      },
      chapterId: {
        regex: "",
        source: "path",
      },
      pageIndex: {
        regex: "",
        source: "path",
      },
    };
  }

  function saveRule() {
    const idx = customRules.findIndex((r) => r.id === editingRule!.id);
    if (idx >= 0) customRules[idx] = editingRule!;
    else customRules.push(editingRule!);
    editingRule = null;
    testResult = null;
  }

  async function testRule() {
    isTesting = true;
    testResult = null;
    try {
      testResult = await browser.runtime.sendMessage({
        type: "TEST_SITE_RULE",
        data: { rule: editingRule },
      });
    } catch {
      testResult = { error: "无法在当前标签页测试规则。" };
    }
    isTesting = false;
  }

</script>

<div>
  <span class="kicker ml-0.5">
    网站解析规则
  </span>
  <div
    class="panel-card !p-2.5 space-y-3"
  >
    {#if editingRule}
      <div class="space-y-1">
        <label
          for="domain"
          class="text-[10px] font-bold uppercase tracking-widest text-zinc-400"
        >
          域名
        </label>
        <input
          id="domain"
          type="text"
          bind:value={editingRule.domain}
          placeholder="例如 mangadex.org"
          class="w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg p-2 text-xs outline-none focus:border-[var(--border-line)]"
        />
      </div>

      <div class="space-y-3">
        <div class="flex justify-between items-center mb-2">
          <span
            class="text-xs font-bold uppercase tracking-widest text-zinc-500"
          >
            编辑规则
          </span>
          <button
            onclick={() => {
              editingRule = null;
              testResult = null;
            }}
            class="text-xs text-zinc-500 hover:text-red-500 cursor-pointer"
          >
            取消
          </button>
        </div>

        <div class="space-y-1.5">
          <label
            for="series-name-rule"
            class="text-[10px] font-bold uppercase tracking-widest text-zinc-500"
          >
            作品名
          </label>
          <div class="flex gap-2">
            <select
              id="series-name-rule"
              bind:value={editingRule.seriesName.source}
              class="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none cursor-pointer"
            >
              <option value="title">标题</option>
              <option value="path">路径</option>
              <option value="hash">哈希</option>
            </select>
            <input
              type="text"
              bind:value={editingRule.seriesName.regex}
              placeholder="正则表达式..."
              class="flex-1 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none font-mono shadow-sm"
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <label
            for="chapter-id-rule"
            class="text-[10px] font-bold uppercase tracking-widest text-zinc-500"
          >
            章节 ID
          </label>
          <div class="flex gap-2">
            <select
              bind:value={editingRule.chapterId.source}
              class="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none cursor-pointer"
            >
              <option value="title">标题</option>
              <option value="path">路径</option>
              <option value="hash">哈希</option>
            </select>
            <input
              id="chapter-id-rule"
              type="text"
              bind:value={editingRule.chapterId.regex}
              placeholder="正则表达式..."
              class="flex-1 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none font-mono shadow-sm"
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <label
            for="page-index-rule"
            class="text-[10px] font-bold uppercase tracking-widest text-zinc-500"
          >
            页码
          </label>
          <div class="flex gap-2">
            <select
              bind:value={editingRule.pageIndex.source}
              class="bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none cursor-pointer"
            >
              <option value="title">标题</option>
              <option value="path">路径</option>
              <option value="hash">哈希</option>
            </select>
            <input
              id="page-index-rule"
              type="text"
              bind:value={editingRule.pageIndex.regex}
              placeholder="正则表达式..."
              class="flex-1 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 text-xs outline-none font-mono shadow-sm"
            />
          </div>
        </div>

        <div
          class="mt-4 p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded-lg"
        >
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs font-bold text-blue-700 dark:text-blue-400">
              在当前标签页实时测试
            </span>
            <button
              onclick={testRule}
              disabled={isTesting}
              class="flex items-center gap-1 px-2 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-[10px] font-bold uppercase tracking-wider cursor-pointer disabled:opacity-50"
            >
              <Play size={10} /> 测试
            </button>
          </div>

          {#if testResult}
            <div
              class="space-y-2 mt-2 pt-2 border-t border-blue-200 dark:border-blue-800/50"
            >
              {#if testResult.error}
                <p class="text-xs text-red-500">{testResult.error}</p>
              {:else}
                <div
                  class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]"
                >
                  <span class="text-zinc-500 font-bold uppercase">作品:</span>
                  <span class="font-mono text-zinc-800 dark:text-zinc-200 truncate">
                    {testResult.context.seriesName}
                  </span>
                  <span class="text-zinc-500 font-bold uppercase">章节:</span>
                  <span class="font-mono text-zinc-800 dark:text-zinc-200 truncate">
                    {testResult.context.chapterId}
                  </span>
                  <span class="text-zinc-500 font-bold uppercase">页码:</span>
                  <span class="font-mono text-zinc-800 dark:text-zinc-200 truncate">
                    {testResult.context.pageIndex}
                  </span>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <button
          onclick={saveRule}
          class="w-full py-2 bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-200 dark:hover:bg-zinc-300 text-white dark:text-zinc-900 rounded-lg text-xs font-bold transition-colors cursor-pointer mt-2"
        >
          保存规则
        </button>

      </div>
    {:else}
      <div class="space-y-2">
        {#each customRules as rule}
          <div
            class="overflow-y-scroll custom-scrollbar max-h-75 flex items-center justify-between p-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm"
          >
            <div class="flex items-center gap-2 overflow-hidden">
              <FileCode size={14} class="text-blue-500 shrink-0" />
              <span class="text-xs font-mono truncate">{rule.domain}</span>
            </div>
            <div class="flex gap-1 shrink-0">
              <button
                onclick={() => (editingRule = { ...rule })}
                class="text-[10px] px-2 py-1 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 cursor-pointer transition-colors"
              >
                编辑
              </button>
              <button
                onclick={() =>
                  (customRules = customRules.filter((r) => r.id !== rule.id))}
                class="p-1 text-zinc-400 hover:text-red-500 cursor-pointer transition-colors"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        {/each}

        {#if customRules.length === 0}
          <div class="text-center py-3 text-xs text-zinc-500 italic">
            还没有自定义规则。
          </div>
        {/if}

        <button
          onclick={addRule}
          class="w-full flex justify-center items-center gap-1 py-2 border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-500 text-zinc-500 hover:text-blue-500 rounded-lg text-xs font-bold transition-colors cursor-pointer mt-2"
        >
          <Plus size={14} /> 添加自定义规则
        </button>
      </div>
    {/if}
  </div>
</div>
