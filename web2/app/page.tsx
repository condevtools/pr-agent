import dynamic from 'next/dynamic'
import Navbar from './components/Navbar'
import HomeMotionMain from './components/HomeMotionMain'
import HeroSection from './components/HeroSection'
import AboutSection from './components/AboutSection'
import ResultsSection from './components/ResultsSection'
import { buildJsonLdGraph } from '../lib/seo-geo'

const ProcessSection = dynamic(() => import('./components/ProcessSection'))
const FeaturesSection = dynamic(() => import('./components/FeaturesSection'))
const BenefitsSection = dynamic(() => import('./components/BenefitsSection'))
const PortfolioSection = dynamic(() => import('./components/PortfolioSection'))
const ServicesSection = dynamic(() => import('./components/ServicesSection'))
const TrustSection = dynamic(() => import('./components/TrustSection'))
const PricingSection = dynamic(() => import('./components/PricingSection'))
const TestimonialsSection = dynamic(() => import('./components/TestimonialsSection'))
const FAQSection = dynamic(() => import('./components/FAQSection'))
const CTASection = dynamic(() => import('./components/CTASection'))

export default function Home() {
  const jsonLd = buildJsonLdGraph()

  return (
    <HomeMotionMain>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Navbar />
      <HeroSection />
      <AboutSection />
      <ResultsSection />
      <ProcessSection />
      <FeaturesSection />
      <BenefitsSection />
      <PortfolioSection />
      <ServicesSection />
      <TrustSection />
      <PricingSection />
      <TestimonialsSection />
      <FAQSection />
      <CTASection />
    </HomeMotionMain>
  )
}
