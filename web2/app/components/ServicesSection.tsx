import Link from 'next/link'

const SERVICES = [
  {
    type: 'Development',
    title: 'Full Website Sprint',
    description:
      'By streamlining the process and focusing on key milestones, we ensure your website is ready to go live quickly, without sacrificing quality.',
    price: '$2,500',
    period: '/ Project',
    duration: '2 - 3 Week',
    includes: ['Design + Framer Development', 'Interactive Elements'],
    cta: null,
  },
  {
    type: 'Design',
    title: 'Full Design Package',
    description:
      'From custom logo designs to comprehensive brand guidelines, web design, and marketing materials, we cover all aspects of your visual presence.',
    price: '$4,500',
    period: '/ Project',
    duration: '3 - 4 Week',
    includes: ['Files + Branding Assets', 'Easy to Edit and Access'],
    cta: null,
  },
  {
    type: 'Development',
    title: 'Full Stack Development',
    description:
      'Whether you\'re building a simple website or a complex web application, our team provides scalable solutions tailored to your needs.',
    price: '$7,500',
    period: '/ Project',
    duration: '4 - 6 Week',
    includes: ['HTML + JavaScript + React Code', 'Database and Back-End'],
    cta: { label: 'Book an Appointment', href: '/contact' },
  },
]

export default function ServicesSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Our Services</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Get High-Quality
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Clear Services Remotely.
              </h2>
            </div>
            <p className="text-white/50 text-sm leading-relaxed max-w-[380px]">
              Discover our range of services designed to elevate your brand and propel your business
              to the next level.
            </p>
          </div>
        </div>

        {/* Service cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/8">
          {SERVICES.map((service) => (
            <div
              key={service.title}
              className="bg-black border border-white/8 p-8 lg:p-10 flex flex-col gap-6"
            >
              {/* Type badge */}
              <span className="inline-flex w-fit px-2.5 py-1 border border-white/12 text-white/45 text-xs">
                {service.type}
              </span>

              {/* Title */}
              <h3 className="text-white text-xl font-semibold">{service.title}</h3>

              {/* Description */}
              <p className="text-white/50 text-sm leading-relaxed flex-1">{service.description}</p>

              {/* Pricing row */}
              <div className="flex items-end gap-2 pt-2 border-t border-white/8">
                <span className="text-white text-3xl font-bold">{service.price}</span>
                <span className="text-white/40 text-sm mb-1">{service.period}</span>
                <div className="ml-auto text-right">
                  <span className="text-[#0055fe] text-sm font-medium">{service.duration}</span>
                </div>
              </div>

              {/* Includes */}
              <div className="flex flex-col gap-2.5">
                {service.includes.map((item) => (
                  <div key={item} className="flex items-center gap-2.5">
                    <svg
                      className="w-3.5 h-3.5 text-[#0055fe] flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-white/65 text-sm">{item}</span>
                  </div>
                ))}
              </div>

              {/* CTA (only for last card) */}
              {service.cta && (
                <Link
                  href={service.cta.href}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors w-fit"
                >
                  {service.cta.label}
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
