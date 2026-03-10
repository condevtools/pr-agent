import Link from 'next/link'

const PLANS = [
  {
    badge: 'Most Pick',
    name: 'Basic',
    price: '$99',
    period: '/ Month',
    originalPrice: '$450',
    description:
      'Our basic pricing plan is designed to offer great value while providing the essential features you need to get started.',
    stats: [
      { value: '100+', label: 'Projects' },
      { value: '75+', label: 'Revisions' },
    ],
    features: [
      'All templates unlocked',
      'Unlimited Licenses',
      'Lifetime Updates',
      'Email support',
      '30-Days Money-back Guarantee',
    ],
    highlight: false,
  },
  {
    badge: 'Recommended',
    name: 'Premium',
    price: '$2,599',
    period: '/ Month',
    originalPrice: null,
    description:
      'Our pro pricing plan is designed for businesses looking for advanced features and premium support.',
    stats: [
      { value: '650+', label: 'Projects' },
      { value: '250+', label: 'Revisions' },
    ],
    features: [
      'All templates unlocked',
      'Unlimited Licenses',
      'Lifetime Updates',
      'Email support',
      '30-Days Money-back Guarantee',
    ],
    highlight: true,
  },
]

export default function PricingSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16 text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Pricing</span>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight mb-2">
            Plans for all businesses, Suitable for
          </h2>
          <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
            Personal, Agencies, Startups.
          </h2>
          <p className="text-white/50 text-sm leading-relaxed max-w-[480px] mx-auto mt-6">
            Our pricing plans are designed to make getting started as effortless as possible. With
            flexible options tailored to suit a variety of needs and budgets.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`relative border p-8 lg:p-10 flex flex-col gap-6 ${
                plan.highlight
                  ? 'border-[#0055fe]/50 bg-[#0055fe]/5'
                  : 'border-white/8 bg-[#080808]'
              }`}
            >
              {/* Badge */}
              <div className="flex items-center justify-between">
                <span
                  className={`px-2.5 py-1 text-xs font-medium border ${
                    plan.highlight
                      ? 'bg-[#0055fe]/15 text-[#0055fe] border-[#0055fe]/30'
                      : 'bg-white/8 text-white/50 border-white/15'
                  }`}
                >
                  {plan.badge}
                </span>
                <h3 className="text-white/60 text-sm">{plan.name}</h3>
              </div>

              {/* Price */}
              <div className="flex items-end gap-2">
                <span className="text-5xl font-bold text-white">{plan.price}</span>
                <div className="mb-1 flex flex-col">
                  <span className="text-white/40 text-sm">{plan.period}</span>
                  {plan.originalPrice && (
                    <span className="text-white/30 text-sm line-through">{plan.originalPrice}</span>
                  )}
                </div>
              </div>

              {/* Description */}
              <p className="text-white/50 text-sm leading-relaxed">{plan.description}</p>

              {/* Stats */}
              <div className="flex gap-6 pt-4 border-t border-white/8">
                {plan.stats.map((stat) => (
                  <div key={stat.label}>
                    <div className="text-2xl font-bold text-white">{stat.value}</div>
                    <div className="text-white/40 text-xs">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Features */}
              <div className="flex flex-col gap-3 flex-1">
                {plan.features.map((feature) => (
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

              {/* CTA */}
              <Link
                href="/contact"
                className={`inline-flex items-center justify-center gap-2 px-6 py-3.5 text-sm font-medium transition-colors ${
                  plan.highlight
                    ? 'bg-[#0055fe] text-white hover:bg-[#0044cc]'
                    : 'border border-white/20 text-white/70 hover:border-white/40 hover:text-white'
                }`}
              >
                Book an Appointment
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
