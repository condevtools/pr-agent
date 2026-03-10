import Navbar from './components/Navbar'
import HeroSection from './components/HeroSection'
import AboutSection from './components/AboutSection'
import ResultsSection from './components/ResultsSection'
import ProcessSection from './components/ProcessSection'
import FeaturesSection from './components/FeaturesSection'
import BenefitsSection from './components/BenefitsSection'
import PortfolioSection from './components/PortfolioSection'
import ServicesSection from './components/ServicesSection'
import TrustSection from './components/TrustSection'
import PricingSection from './components/PricingSection'
import TestimonialsSection from './components/TestimonialsSection'
import FAQSection from './components/FAQSection'
import CTASection from './components/CTASection'

export default function Home() {
  return (
    <main className="bg-black min-h-screen">
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
    </main>
  )
}
