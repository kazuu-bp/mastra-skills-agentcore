/**
 * .mts（ES Module TypeScript）を使用している理由:
 * トップレベル await（await client.send(...)など）を使うために
 * ES Module 形式が必要なため。
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'

// AgentCore クライアントを初期化
const client = new BedrockAgentCoreClient({ region: 'ap-northeast-1' })

// 呼び出すエージェントのARN（環境変数 RUNTIME_ARN で指定）
const agentArn = process.env.RUNTIME_ARN
if (!agentArn) {
  console.error('Error: RUNTIME_ARN environment variable is not set.')
  process.exit(1)
}

// --genu フラグの判定
const args = process.argv.slice(2)
const isGenu = args.includes('--genu')
const promptArgs = args.filter((a) => a !== '--genu')

// プロンプト（引数で上書き可能）
const promptText = promptArgs[0] ?? '何ができる？'

console.log(`Invoking AgentCore Runtime...`)
console.log(`Format: ${isGenu ? 'GenU' : '簡易形式'}`)
console.log(`Prompt: ${promptText}\n`)

// ペイロードの構築: GenU形式 or 簡易形式
let payload: string
if (isGenu) {
  // GenU形式: messages 配列を使用
  payload = JSON.stringify({
    messages: [{ role: 'user', content: promptText }],
    model: { modelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0' },
  })
} else {
  // 簡易形式: prompt 文字列を使用
  payload = JSON.stringify({ prompt: promptText })
}

const command = new InvokeAgentRuntimeCommand({
  agentRuntimeArn: agentArn,
  runtimeSessionId: crypto.randomUUID(),
  payload: new TextEncoder().encode(payload),
  contentType: 'application/json',
  accept: 'text/event-stream',
})

const response = await client.send(command)

// ストリーミングレスポンスを処理
if (response.response) {
  const stream = response.response as AsyncIterable<Buffer>
  for await (const chunk of stream) {
    const text = new TextDecoder().decode(chunk)
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          if (isGenu) {
            // GenU形式: contentBlockDelta からテキストを取り出す
            const deltaText = data?.event?.contentBlockDelta?.delta?.text
            if (deltaText) process.stdout.write(deltaText)
          } else {
            // 簡易形式: data.text
            if (data.text) process.stdout.write(data.text)
          }
        } catch {
          // パースエラーは無視
        }
      }
    }
  }
}
console.log()
