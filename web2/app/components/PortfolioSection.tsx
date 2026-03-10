import Link from 'next/link'

const PROJECTS = [
  {
    name: 'Way Fields',
    year: '2024',
    tags: ['E-Commerce', 'Portfolio'],
    href: '/portfolio/wayfields',
    color: 'from-emerald-900/40 to-black',
  },
  {
    name: 'Raven Studio',
    year: '2025',
    tags: ['Business', 'Agency'],
    href: '/portfolio/raven-studio',
    color: 'from-violet-900/40 to-black',
  },
  {
    name: 'White Stag',
    year: '2024',
    tags: ['SASS', 'Landing Page'],
    href: '/portfolio/whitestag',
    color: 'from-sky-900/40 to-black',
  },
]

export default function PortfolioSection() {
  return (
    <section className="bg-black py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
        {/* Header */}
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            <span className="text-white/50 text-sm">Portfolio</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                Our Selected Projects
              </h2>
              <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
                That Propel Your Website.
              </h2>
            </div>
            <div className="flex flex-col gap-4 lg:items-end">
              <p className="text-white/50 text-sm leading-relaxed max-w-[380px]">
                Explore our curated work, showcasing collaborations with visionary clients across
                diverse industries.
              </p>
              <Link
                href="/portfolio"
                className="inline-flex items-center gap-2 text-white/60 text-sm hover:text-white transition-colors w-fit"
              >
                View Portfolio
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>

        {/* Project cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PROJECTS.map((project) => (
            <Link
              key={project.name}
              href={project.href}
              className="group relative bg-[#080808] border border-white/8 overflow-hidden aspect-[4/5] flex flex-col justify-between p-6 hover:border-white/20 transition-colors"
            >
              {/* Background gradient */}
              <div
                className={`absolute inset-0 bg-gradient-to-b ${project.color} opacity-60 group-hover:opacity-80 transition-opacity`}
              />

              {/* Year */}
              <div className="relative z-10 flex items-start justify-between">
                <span className="text-white/40 text-sm">{project.year}</span>
                <svg
                  className="w-5 h-5 text-white/30 group-hover:text-white/70 transition-colors -rotate-45"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </div>

              {/* Tags + Name */}
              <div className="relative z-10">
                <div className="flex flex-wrap gap-2 mb-3">
                  {project.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-1 border border-white/15 text-white/55 text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <h3 className="text-white text-xl font-semibold">{project.name}</h3>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
