import { defineComponent, ref, watch } from 'vue'
import { NButton, NPagination, useMessage, NInputGroup, NIcon } from 'naive-ui'
import { useStore } from '../store.ts'
import { commands } from '../bindings.ts'
import ComicCard from '../components/ComicCard.tsx'
import { PhArrowRight, PhMagnifyingGlass } from '@phosphor-icons/vue'
import FloatLabelInput from '../components/FloatLabelInput.tsx'
import { extractComicId } from '../utils.ts'

export default defineComponent({
  name: 'SearchPane',
  setup() {
    const store = useStore()

    const message = useMessage()

    const searchByKeywordInput = ref<string>('')
    const searchingByKeyword = ref<boolean>(false)
    const searchByTagInput = ref<string>('')
    const searchingByTag = ref<boolean>(false)
    const searchByComicIdInput = ref<string>('')
    const currentPage = ref<number>(1)
    const comicCardContainer = ref<HTMLElement>()
    const downloadingAllSearchResults = ref<boolean>(false)
    const lastSearchMode = ref<'keyword' | 'tag'>('keyword')
    const lastSearchKeyword = ref<string>('')
    const lastSearchTag = ref<string>('')

    watch(
      () => store.searchResult,
      () => {
        if (comicCardContainer.value !== undefined) {
          comicCardContainer.value.scrollTo({ top: 0, behavior: 'instant' })
        }
      },
    )

    async function searchByKeyword(keyword: string, pageNum: number) {
      searchByKeywordInput.value = keyword
      currentPage.value = pageNum

      searchingByKeyword.value = true

      const result = await commands.searchByKeyword(keyword, pageNum)
      if (result.status === 'error') {
        searchingByKeyword.value = false
        console.error(result.error)
        return
      }

      searchingByKeyword.value = false
      lastSearchMode.value = 'keyword'
      lastSearchKeyword.value = keyword
      store.searchResult = result.data
    }

    async function searchByTag(tagName: string, pageNum: number) {
      searchByTagInput.value = tagName
      currentPage.value = pageNum

      searchingByTag.value = true

      const result = await commands.searchByTag(tagName, pageNum)
      if (result.status === 'error') {
        searchingByTag.value = false
        console.error(result.error)
        return
      }

      searchingByTag.value = false
      lastSearchMode.value = 'tag'
      lastSearchTag.value = tagName
      store.searchResult = result.data
      store.currentTabName = 'search'
    }

    async function onPageChange(page: number) {
      if (store.searchResult === undefined) {
        return
      }

      if (store.searchResult.isSearchByTag) {
        await searchByTag(searchByTagInput.value.trim(), page)
      } else {
        await searchByKeyword(searchByKeywordInput.value.trim(), page)
      }
    }

    async function pickComic() {
      const comicId = extractComicId(searchByComicIdInput.value)
      if (comicId === undefined) {
        message.error('漫画ID格式错误，请输入漫画ID或漫画链接')
        return
      }

      const result = await commands.getComic(comicId)
      if (result.status === 'error') {
        console.error(result.error)
        return
      }

      store.pickedComic = result.data
      store.currentTabName = 'comic'
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => window.setTimeout(resolve, ms))
    }

    function isActiveDownloadTask(comicId: number): boolean {
      const state = store.progresses.get(comicId)?.state
      return state === 'Pending' || state === 'Downloading'
    }

    async function collectSearchResultIds(): Promise<{ ids: number[]; skippedDownloaded: number; skippedActive: number }> {
      const ids = new Set<number>()
      let skippedDownloaded = 0
      let skippedActive = 0

      if (store.searchResult === undefined) {
        return { ids: [], skippedDownloaded, skippedActive }
      }

      const totalPage = store.searchResult.totalPage
      const mode = store.searchResult.isSearchByTag ? 'tag' : 'keyword'
      const keyword = mode === 'tag' ? lastSearchTag.value.trim() : lastSearchKeyword.value.trim()

      for (let page = 1; page <= totalPage; page += 1) {
        let comics = store.searchResult.comics

        if (page !== currentPage.value) {
          const result =
            mode === 'tag'
              ? await commands.searchByTag(keyword, page)
              : await commands.searchByKeyword(keyword, page)

          if (result.status === 'error') {
            console.error(result.error)
            continue
          }

          comics = result.data.comics
        }

        for (const comic of comics) {
          if (comic.isDownloaded) {
            skippedDownloaded += 1
            continue
          }
          if (isActiveDownloadTask(comic.id)) {
            skippedActive += 1
            continue
          }
          ids.add(comic.id)
        }

        await sleep(150)
      }

      return { ids: Array.from(ids), skippedDownloaded, skippedActive }
    }

    async function downloadAllSearchResults() {
      if (downloadingAllSearchResults.value) {
        message.warning('正在批量加入下载队列，请稍后再试')
        return
      }

      if (searchingByKeyword.value || searchingByTag.value) {
        message.warning('有搜索正在进行，请稍后再试')
        return
      }

      if (store.searchResult === undefined || store.searchResult.totalPage <= 0) {
        message.warning('没有可下载的搜索结果')
        return
      }

      const mode = store.searchResult.isSearchByTag ? 'tag' : 'keyword'
      const keyword = mode === 'tag' ? lastSearchTag.value.trim() : lastSearchKeyword.value.trim()
      if (keyword.length === 0) {
        message.warning('请先完成一次关键词或标签搜索')
        return
      }

      downloadingAllSearchResults.value = true

      let queuedCount = 0
      let failedCount = 0
      let skippedDownloaded = 0
      let skippedActive = 0

      try {
        const collected = await collectSearchResultIds()
        skippedDownloaded = collected.skippedDownloaded
        skippedActive = collected.skippedActive

        if (collected.ids.length === 0) {
          message.warning('没有新的搜索结果需要下载')
          return
        }

        for (const comicId of collected.ids) {
          try {
            const comicResult = await commands.getComic(comicId)
            if (comicResult.status === 'error') {
              console.error(comicResult.error)
              failedCount += 1
              continue
            }

            await commands.createDownloadTask(comicResult.data)
            queuedCount += 1
          } catch (err) {
            console.error(err)
            failedCount += 1
          }

          await sleep(150)
        }

        message.success(
          `已加入队列：${queuedCount}，失败：${failedCount}，跳过已下载：${skippedDownloaded}，跳过下载中：${skippedActive}`,
        )
      } finally {
        downloadingAllSearchResults.value = false
      }
    }

    const render = () => (
      <div class="h-full flex flex-col gap-2">
        <NInputGroup class="box-border px-2 pt-2">
          <FloatLabelInput
            size="small"
            label="关键词"
            value={searchByKeywordInput.value}
            onUpdate:value={(value) => (searchByKeywordInput.value = value)}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await searchByKeyword(searchByKeywordInput.value.trim(), 1)
                }
              },
            }}
          />
          <NButton
            loading={searchingByKeyword.value}
            type="primary"
            size="small"
            class="w-15%"
            onClick={() => searchByKeyword(searchByKeywordInput.value.trim(), 1)}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhMagnifyingGlass />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>
        <NInputGroup class="box-border px-2">
          <FloatLabelInput
            size="small"
            label="标签"
            value={searchByTagInput.value}
            onUpdate:value={(value) => (searchByTagInput.value = value)}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await searchByTag(searchByTagInput.value.trim(), 1)
                }
              },
            }}
          />
          <NButton
            loading={searchingByTag.value}
            type="primary"
            size="small"
            class="w-15%"
            onClick={() => searchByTag(searchByTagInput.value.trim(), 1)}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhMagnifyingGlass />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>
        <NInputGroup class="box-border px-2">
          <FloatLabelInput
            size="small"
            label="漫画ID (链接也行)"
            value={searchByComicIdInput.value}
            onUpdate:value={(value) => (searchByComicIdInput.value = value)}
            clearable
            {...{
              onKeydown: async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  await pickComic()
                }
              },
            }}
          />
          <NButton type="primary" size="small" class="w-15%" onClick={() => pickComic()}>
            {{
              icon: () => (
                <NIcon size={22}>
                  <PhArrowRight />
                </NIcon>
              ),
            }}
          </NButton>
        </NInputGroup>

        {store.searchResult && (
          <>
            <NButton
              class="mx-2"
              type="primary"
              secondary
              size="small"
              loading={downloadingAllSearchResults.value}
              disabled={store.searchResult.totalPage <= 0}
              onClick={() => downloadAllSearchResults()}>
              一键下载全部搜索结果（共 {store.searchResult.totalPage} 页）
            </NButton>
            <div class="flex flex-col overflow-auto">
              <div ref={comicCardContainer} class="flex flex-col gap-row-2 overflow-auto p-2">
                {store.searchResult.comics.map((comic) => (
                  <ComicCard
                    key={comic.id}
                    comicId={comic.id}
                    comicTitle={comic.title}
                    comicTitleHtml={comic.titleHtml}
                    comicCover={comic.cover}
                    comicAdditionalInfo={comic.additionalInfo}
                    comicDownloaded={comic.isDownloaded}
                  />
                ))}
              </div>
            </div>
            <NPagination
              class="p-2 mt-auto"
              page={currentPage.value}
              pageCount={store.searchResult.totalPage}
              onUpdate:page={(page) => onPageChange(page)}
            />
          </>
        )}
      </div>
    )

    return { render, searchByTag }
  },

  render() {
    return this.render()
  },
})