// Mobile menu --------------------------------------------------------------
const menuBtn = document.getElementById('menu-btn');
const nav     = document.getElementById('nav');
menuBtn.addEventListener('click', () => nav.classList.toggle('hidden'));

// Anno nel footer -----------------------------------------------------------
document.getElementById('year').textContent = new Date().getFullYear();

// Scroll-reveal -------------------------------------------------------------
const revealEls = document.querySelectorAll('.feature-card, .section-title');
const io = new IntersectionObserver(entries => {
  entries.forEach(e => e.isIntersecting && e.target.classList.add('revealed'));
}, { threshold: 0.15 });
revealEls.forEach(el => { el.classList.add('reveal'); io.observe(el); });
