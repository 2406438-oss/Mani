const screens = document.querySelectorAll('.screen');

function goTo(id) {
  screens.forEach((screen) => screen.classList.toggle('is-active', screen.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-go]').forEach((button) => {
  button.addEventListener('click', () => goTo(button.dataset.go));
});

document.getElementById('booking-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  document.getElementById('summary-service').textContent = value('service');
  document.getElementById('summary-master').textContent = value('master');
  document.getElementById('summary-date').textContent = `${value('date')} · ${value('time')}`;
  goTo('confirmation');
});
