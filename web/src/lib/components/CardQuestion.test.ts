import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import CardQuestion from './CardQuestion.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    answerQuestion: vi.fn().mockResolvedValue({ ok: true }),
    rejectQuestion: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

const card = {
  kind: 'question' as const,
  sessionId: 'ses_1',
  id: 'question:que_1',
  requestId: 'que_1',
  questions: [
    { question: '部署到生产？', header: 'Deploy', options: [{ label: '是', description: 'go' }, { label: '否' }] },
    { question: '选环境', header: 'Env', multiple: true, options: [{ label: 'dev' }, { label: 'prod' }] },
  ],
}

describe('CardQuestion', () => {
  beforeEach(() => {
    vi.mocked(api.answerQuestion).mockClear().mockResolvedValue({ ok: true })
    vi.mocked(api.rejectQuestion).mockClear().mockResolvedValue({ ok: true })
  })

  it('submits raw labels per question (single + multi)', async () => {
    const { getByText } = render(CardQuestion, { props: { card } })
    await fireEvent.click(getByText('是'))
    await fireEvent.click(getByText('dev'))
    await fireEvent.click(getByText('prod'))
    await fireEvent.click(getByText('提交回答'))
    await tick()
    expect(api.answerQuestion).toHaveBeenCalledWith('ses_1', 'que_1', [['是'], ['dev', 'prod']])
  })

  it('disables submit until every question is answered', async () => {
    const { getByText } = render(CardQuestion, { props: { card } })
    await fireEvent.click(getByText('是'))
    await tick()
    expect((getByText('提交回答') as HTMLButtonElement).disabled).toBe(true) // Q2 unanswered
    await fireEvent.click(getByText('dev'))
    await tick()
    expect((getByText('提交回答') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reject posts rejectQuestion', async () => {
    const { container } = render(CardQuestion, { props: { card } })
    const rej = container.querySelector('.a.rej') as HTMLButtonElement
    await fireEvent.click(rej)
    await tick()
    expect(api.rejectQuestion).toHaveBeenCalledWith('ses_1', 'que_1')
  })

  it('renders the resolved state from a republished card (answered elsewhere)', async () => {
    const { container } = render(CardQuestion, {
      props: { card: { ...card, questions: [], resolved: 'replied' as const } },
    })
    expect(container.textContent).toContain('已回答')
    expect(api.answerQuestion).not.toHaveBeenCalled()
  })
})
