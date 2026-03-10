import Link from 'next/link'

const STAGES = [
  {
    number: 'Stage 1',
    title: 'Kickoff',
    description:
      'The kickoff stage is where everything begins. We align with you to understand your goals, vision, and expectations. Through in-depth discussions and thorough research.',
    features: ['Comprehensive Consultation', 'Project Roadmap'],
    cta: null,
  },
  {
    number: 'Stage 2',
    title: 'Execution',
    description:
      'With a clear strategy in place, we move into the execution phase, where ideas come to life. Our team works high efficiently and collaboratively to implement the plan.',
    features: ['Seamless Integration', 'Real Time Collaboration'],
    cta: null,
  },
  {
    number: 'Stage 3',
    title: 'Handoff',
    description:
      'Once the design and development are finalized, we seamlessly transition to the handoff stage. Here, we provide you with all the assets, documentation, and support to a smooth launch.',
    features: ['Ongoing Support', 'Documentation'],
    cta: { label: 'Book an Appointment', href: '/contact' },
  },
]

export default function ProcessSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">How We Work?</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                We Simplify The Journey
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                From Design To Launch.
              </h2>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[400px]">
              We make it easy to bring your ideas to life, guiding you from concept to a fully
              launched product.
            </p>
          </div>
        </div>

        {/* Stage cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/8">
          {STAGES.map((stage, idx) => (
            <div
              key={stage.number}
              className="bg-black p-8 lg:p-10 flex flex-col gap-6 border border-white/8"
              style={{ borderLeft: idx > 0 ? 'none' : undefined }}
            >
              <div className="flex flex-col gap-2">
                <span className="text-white/35 text-xs font-medium tracking-wider uppercase">
                  {stage.number}
                </span>
                <h3 className="text-white text-xl font-semibold">{stage.title}</h3>
              </div>

              <p className="text-white/50 text-sm leading-relaxed flex-1">{stage.description}</p>

              <div className="flex flex-col gap-2.5 pt-4 border-t border-white/8">
                {stage.features.map((feature) => (
                  <div key={feature} className="flex items-center gap-2.5">
                    <svg
                      className="w-3.5 h-3.5 text-[#0055fe] flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-white/65 text-sm">{feature}</span>
                  </div>
                ))}
              </div>

              {stage.cta && (
                <Link
                  href={stage.cta.href}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
                >
                  {stage.cta.label}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
