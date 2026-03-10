'use client'

import { useState } from 'react'

const FAQS = [
  {
    question: 'What do I need to get started?',
    answer:
      'To get started, simply reach out through our contact form or book a 15-minute discovery call. We\'ll discuss your goals, timeline, and budget to determine the best plan for your needs.',
  },
  {
    question: 'What kind of customization is available?',
    answer:
      'We offer extensive customization options including brand colors, typography, layout adjustments, custom animations, and fully bespoke UI components — all tailored to match your brand identity.',
  },
  {
    question: 'How easy is it to edit for beginners?',
    answer:
      'Our deliverables are designed with non-technical users in mind. We provide clean, well-structured files along with documentation and onboarding sessions to ensure you can manage your site confidently.',
  },
  {
    question: 'Let me know more about the money-back guarantee?',
    answer:
      'We offer a 30-day money-back guarantee. If you\'re not satisfied with our work within the first 30 days, we\'ll issue a full refund — no questions asked. Your satisfaction is our top priority.',
  },
  {
    question: 'Do I need to know how to code?',
    answer:
      'No coding knowledge is required. We handle all the technical aspects, from design to development and deployment. You simply provide your vision and we take care of the rest.',
  },
  {
    question: 'What will I get after purchasing the template?',
    answer:
      'After purchase you receive the complete source files, a fully editable design in your preferred format, documentation, lifetime updates, and access to our support team for onboarding assistance.',
  },
]

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
          {/* Left: header */}
          <div className="flex flex-col gap-6">
            <div className="inline-flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
              <span className="text-white/50 text-sm">FAQ</span>
            </div>
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Asked Questions
              </h2>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[360px]">
              Have questions? Our FAQ section has you covered with quick answers to the most common
              inquiries.
            </p>
          </div>

          {/* Right: accordion */}
          <div className="flex flex-col divide-y divide-white/8">
            {FAQS.map((faq, idx) => (
              <div key={faq.question}>
                <button
                  className="w-full flex items-start justify-between gap-4 py-5 text-left group"
                  onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
                >
                  <span
                    className={`text-sm font-medium transition-colors ${
                      openIndex === idx ? 'text-white' : 'text-white/70 group-hover:text-white'
                    }`}
                  >
                    {faq.question}
                  </span>
                  <span
                    className={`flex-shrink-0 w-5 h-5 flex items-center justify-center border border-white/15 transition-all ${
                      openIndex === idx ? 'border-[#0055fe]/50 bg-[#0055fe]/10 rotate-45' : ''
                    }`}
                  >
                    <svg
                      className={`w-2.5 h-2.5 transition-colors ${
                        openIndex === idx ? 'text-[#0055fe]' : 'text-white/40'
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                    </svg>
                  </span>
                </button>
                {openIndex === idx && (
                  <div className="pb-5">
                    <p className="text-white/50 text-sm leading-relaxed">{faq.answer}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
