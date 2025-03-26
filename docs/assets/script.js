document.addEventListener('DOMContentLoaded', function() {
    // 添加页面滚动动画效果
    const sections = document.querySelectorAll('section');
    
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };
    
    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('fade-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    sections.forEach(section => {
        section.classList.add('section-hidden');
        observer.observe(section);
    });
    
    // 图片画廊交互
    const galleryItems = document.querySelectorAll('.gallery-item');
    galleryItems.forEach(item => {
        item.addEventListener('click', function() {
            this.classList.toggle('gallery-item-expanded');
        });
    });
    
    // 性能数据动画
    const specValues = document.querySelectorAll('.spec-value');
    specValues.forEach(value => {
        const finalValue = value.textContent;
        value.textContent = '0';
        
        setTimeout(() => {
            animateValue(value, 0, parseFloat(finalValue), 1500);
        }, 500);
    });
    
    function animateValue(obj, start, end, duration) {
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            
            // 检查是否包含非数字字符
            const originalText = obj.getAttribute('data-original') || end;
            if (isNaN(end)) {
                obj.textContent = originalText;
                return;
            }
            
            obj.textContent = Math.floor(progress * (end - start) + start);
            if (progress < 1) {
                window.requestAnimationFrame(step);
            } else {
                obj.textContent = originalText;
            }
        };
        window.requestAnimationFrame(step);
    }
    
    // 添加平滑滚动效果
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});