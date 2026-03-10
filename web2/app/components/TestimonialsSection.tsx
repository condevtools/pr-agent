import Link from 'next/link'

const TESTIMONIALS = [
  {
    quote:
      'They not only delivered a top-notch website but also provided strategic insights that helped us improve our overall digital presence.',
    name: 'John Smith',
    role: 'CEO',
    company: 'Innovate Solutions',
  },
  {
    quote:
      'The team understood our complex requirements and provided a user-friendly, high-performing website that stands out in the market.',
    name: 'Emily Davis',
    role: 'Product Manager',
    company: 'Nexus Digital',
  },
  {
    quote:
      'Their innovative solutions helped streamline our operations, and the website design and development is both functional and visually stunning.',
    name: 'David Lee',
    role: 'Founder',
    company: 'GreenLeaf Enterprises',
  },
  {
    quote:
      "We were blown away by the creative approach and attention to detail. The team took our ideas and turned them into a stunning website.",
    name: 'Mark Thompson',
    role: 'Creative Director',
    company: 'PixelWorks Studio',
  },
  {
    quote:
      'They delivered a customized solution that addressed all of our business needs. The website is sleek, functional, and improved our customer experience.',
    name: 'Brian Clark',
    role: 'Team Lead',
    company: 'Mandro Designs',
  },
  {
    quote:
      "The team's dedication and attention to detail are unmatched. They delivered a beautifully designed website that perfectly reflects our brand.",
    name: 'Daniel Carter',
    role: 'Founder',
    company: 'Fusion Studios',
  },
]

export default function TestimonialsSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Testimonial</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Customer Reviews About
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Work, Usability and Design.
              </h2>
            </div>
            <div className="flex flex-col gap-4 lg:items-end">
              <p className="text-white/50 text-sm leading-relaxed max-w-[380px]">
                Hear from our happy clients! See how we&apos;ve helped them achieve their goals and
                create lasting impact.
              </p>
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors w-fit"
              >
                View About Landin
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>

        {/* Testimonial grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {TESTIMONIALS.map((t) => (
            <div
              key={t.name}
              className="bg-[#080808] border border-white/8 p-7 flex flex-col gap-5"
            >
              {/* Quote mark */}
              <svg
                className="w-8 h-8 text-[#0055fe]/40"
                fill="currentColor"
                viewBox="0 0 32 32"
              >
                <path d="M9.352 4C4.456 7.456 1 13.12 1 19.36c0 5.088 3.072 8.064 6.624 8.064 3.36 0 5.856-2.688 5.856-5.856 0-3.168-2.208-5.472-5.088-5.472-.576 0-1.344.096-1.536.192.48-3.264 3.552-7.104 6.624-9.024L9.352 4zm16.512 0c-4.8 3.456-8.256 9.12-8.256 15.36 0 5.088 3.072 8.064 6.624 8.064 3.264 0 5.856-2.688 5.856-5.856 0-3.168-2.304-5.472-5.184-5.472-.576 0-1.248.096-1.44.192.48-3.264 3.456-7.104 6.528-9.024L25.864 4z" />
              </svg>

              {/* Quote */}
              <p className="text-white/65 text-sm leading-relaxed flex-1">&ldquo;{t.quote}&rdquo;</p>

              {/* Author */}
              <div className="flex items-center gap-3 pt-4 border-t border-white/8">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-white/20 to-white/5 flex items-center justify-center">
                  <span className="text-white/60 text-xs font-medium">{t.name[0]}</span>
                </div>
                <div>
                  <div className="text-white text-sm font-medium">{t.name}</div>
                  <div className="text-white/40 text-xs">
                    {t.role} · {t.company}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
