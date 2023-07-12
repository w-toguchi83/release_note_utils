require('dotenv').config()

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { program } = require('commander')
const { Configuration, OpenAIApi } = require("openai");

program
  .option('--since <since>', 'since')
  .option('--until <until>', 'until')
  .option('--skip-checkout-pull', 'skip checkout & pull')
  .option('--skip-ai', 'skip AI')

program.parse()
const options = program.opts()

const SCRIPT_FILE_PATH = process.argv[1]
const SCRIPT_DIR = path.dirname(SCRIPT_FILE_PATH)

const REPO_DIR = `${SCRIPT_DIR}/repos`

const REPO_URL_LIST = []
let i = 0
while (process.env[`REPO_URL_${i}`]) {
  REPO_URL_LIST.push(process.env[`REPO_URL_${i}`])
  i++
}

const RELEASE_NOTE_DIR = `${SCRIPT_DIR}/release_notes`

const MODEL = 'gpt-3.5-turbo'
const PROMPT = `あなたはテクニカルエディターです。
git log の出力からリリースノートを作成してください。
リリースの内容はビジネスサイドの人間にもわかりやすくなるように工夫してください。

リリースノートは月単位でまとめて、日にちは昇順で並べます。
また各リリースはプルリクエスト番号単位でまとめてください。
リリースは、mainブランチへのマージに限定してください。それ以外のマージは除外してください。
以下はリリースノート(Markdown形式)のサンプルです。

===サンプル

**$(リポジトリ名) リリースノート - 2023年01月**

* 2023-01-08 - ○○機能が追加されました。[PR #123](https://github.com/owner/repo/pull/123)
* 2023-01-10 - △△対策が行われました。[PR #456](https://github.com/owner/repo/pull/456)
* 2023-01-15 - □□を修正しました。[PR #789](https://github.com/owner/repo/pull/789)

詳細は各プルリクエストを参照してください。`

/**
 * マージコミットからリリースノートを作成する.
 */
async function main() {
  let {
    since,
    until,
    skipCheckoutPull,
    skipAi,
  } = options

  skipCheckoutPull = !!skipCheckoutPull
  skipAi = !!skipAi

  if ((since && !until) || (!since && until)) {
    throw new Error('since と until は同時に指定する必要があります')
  }
  if (since && !since.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error('since の形式が不正です. YYYY-MM-DD の形式で指定してください')
  }
  if (until && !until.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error('until の形式が不正です. YYYY-MM-DD の形式で指定してください')
  }

  if (!since && !until) {
    // デフォルトで先月の1日から末日までを設定する
    const now = new Date()
    const year = now.getFullYear()
    const month = (now.getMonth() + 1) - 1 // 先月
    const lastDay = new Date(year, month, 0)
    since = `${year}-${month.toString().padStart(2, '0')}-01`
    until = `${year}-${month.toString().padStart(2, '0')}-${lastDay.getDate().toString().padStart(2, '0')}`
  }

  execSync(`mkdir -p ${REPO_DIR}`)
  execSync(`mkdir -p ${RELEASE_NOTE_DIR}`)

  const REPO_NAME_LIST = []
  for (const REPO_URL of REPO_URL_LIST) {
    const REPO_NAME = REPO_URL.split('/').pop().replace(/\.git$/, '')
    REPO_NAME_LIST.push(REPO_NAME)
    if (!fs.existsSync(`${REPO_DIR}/${REPO_NAME}`)) {
      // 存在しない場合は clone する
      const cmd = `git clone ${REPO_URL} ${REPO_DIR}/${REPO_NAME}`
      console.log(cmd)
      execSync(cmd)
    }
  }

  if (!skipCheckoutPull) {
    for (const REPO_NAME of REPO_NAME_LIST) {
      const REPO_PATH = `${REPO_DIR}/${REPO_NAME}`
      const cmd = `cd ${REPO_PATH} && git checkout main && git pull`
      console.log(cmd)
      execSync(cmd)
    }
  }

  // マージコミットのログを取得する
  const REPO_TO_LOG = {}
  for (const REPO_NAME of REPO_NAME_LIST) {
    const REPO_PATH = `${REPO_DIR}/${REPO_NAME}`
    const cmd = `cd ${REPO_PATH} && git log --merges --since="${since}" --until="${until}" --date=short`
    const output = execSync(cmd, { encoding: 'utf8' })
    REPO_TO_LOG[REPO_NAME] = output
  }

  console.log('----------------------------------------')
  console.log('リリースノートを作成します')
  console.log('----------------------------------------')
  console.log('')

  if (process.env.OPENAI_API_KEY && !skipAi) {
    const configuration = new Configuration({
      apiKey: process.env.OPENAI_API_KEY,
    })
    const openapi = new OpenAIApi(configuration)

    for (const REPO_NAME of REPO_NAME_LIST) {
      const log = REPO_TO_LOG[REPO_NAME]
      if (!log) {
        console.warn(`リポジトリ ${REPO_NAME} にはマージコミットがありません`)
        continue
      }
      const content = `リポジトリ名: ${REPO_NAME}\n\n${REPO_TO_LOG[REPO_NAME]}\n\n`
      try {
        const chatCompletion = await openapi.createChatCompletion({
          model: MODEL,
          messages: [
            {role: 'system', content: PROMPT},
            {role: 'user', content},
          ],
        })

        const note = chatCompletion.data.choices[0]?.message?.content
        console.log(note)
        console.log('')
        await saveReleaseNote(REPO_NAME, since, until, note)
      } catch (e) {
        console.error(e)
      }
    }
  } else {
    // OPENAI API を使用しない場合
    for (const REPO_NAME of REPO_NAME_LIST) {
      const log = REPO_TO_LOG[REPO_NAME]
      if (!log) {
        console.warn(`リポジトリ ${REPO_NAME} にはマージコミットがありません`)
        continue
      }
      const content = `リポジトリ名: ${REPO_NAME}\n\n${REPO_TO_LOG[REPO_NAME]}\n\n`
      console.log(content)
      console.log('')
    }
  }
}

async function saveReleaseNote(repoName, since, until, note) {
  const fileName = `${repoName}_${since}_${until}.md`
  const filePath = `${RELEASE_NOTE_DIR}/${fileName}`
  fs.writeFileSync(filePath, note)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
