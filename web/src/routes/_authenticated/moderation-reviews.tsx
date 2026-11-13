import { createFileRoute } from '@tanstack/react-router'
import { ModerationReviewsPage } from '@/features/moderation-reviews'

export const Route = createFileRoute('/_authenticated/moderation-reviews')({
  component: ModerationReviewsPage,
})
