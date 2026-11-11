/**
 * AI Qisao background-layer optics. No DOM screenshots or experimental APIs.
 * Pass 1 renders the actual backdrop to a framebuffer; pass 2 refracts that
 * texture through rounded glass lenses while all controls remain native DOM.
 * SDF / separated RGB sampling follows the liquid-glass-web reference:
 * https://github.com/jpoindexter/liquid-glass-web (implementation written here).
 */
const VERTEX = `attribute vec2 aPosition;
void main(){ gl_Position=vec4(aPosition,0.,1.); }`;

const SCENE = `precision highp float;
uniform sampler2D uSource;
uniform vec2 uResolution;
void main(){gl_FragColor=texture2D(uSource,gl_FragCoord.xy/uResolution);}`;

const OPTICS = `precision highp float;
uniform sampler2D uBackdrop;
uniform vec2 uResolution, uViewport;
uniform vec4 uRect;
uniform float uRadius, uDark, uLens, uRefraction, uCorner;
uniform vec2 uLight;
float sdf(vec2 p, vec2 halfSize, float r){
 vec2 q=abs(p)-halfSize+r;
  float power=pow(2.,uCorner);
 vec2 positive=max(q,0.);
 return pow(pow(positive.x,power)+pow(positive.y,power),1./power)+min(max(q.x,q.y),0.)-r;
}
vec3 readBackdrop(vec2 uv){return texture2D(uBackdrop,clamp(uv,vec2(.001),vec2(.999))).rgb;}
void main(){
 vec2 uv=gl_FragCoord.xy/uResolution;
 if(uLens<.5){gl_FragColor=vec4(readBackdrop(uv),1.);return;}
 vec2 pos=vec2(uv.x,1.-uv.y)*uViewport;
 vec2 halfSize=uRect.zw*.5;
 vec2 local=pos-uRect.xy-halfSize;
 float radius=min(uRadius,min(halfSize.x,halfSize.y));
 float d=sdf(local,halfSize,radius);
 float coverage=1.-smoothstep(-.65,.65,d);
 if(coverage<=0.)discard;
 float band=min(25.,min(halfSize.x,halfSize.y)*.65);
 float edge=clamp(1.+d/band,0.,1.);
 // Finite SDF gradient gives the physical outward normal, including the corners.
 vec2 g=vec2(sdf(local+vec2(.5,0.),halfSize,radius)-sdf(local-vec2(.5,0.),halfSize,radius),
             sdf(local+vec2(0.,.5),halfSize,radius)-sdf(local-vec2(0.,.5),halfSize,radius));
 vec2 outward=g/max(length(g),.001);
 float slope=edge*edge*.94;
 vec3 normal=normalize(vec3(outward*slope,sqrt(max(.01,1.-slope*slope))));
 // Snell refraction (air / glass IOR 1.46). Interior is flat and undistorted.
 vec3 ray=refract(vec3(0.,0.,-1.),normal,1./1.46);
 vec2 shift=-ray.xy/max(abs(ray.z),.1)*38.;
 shift*=vec2(1.,-1.)/uViewport*uRefraction;
 vec2 at=uv+shift;
 vec2 soft=vec2(1.4)/uViewport;
 vec3 body=readBackdrop(at)*.5+(readBackdrop(at+soft)+readBackdrop(at-soft))*.25;
 vec3 dispersion=vec3(readBackdrop(uv+shift*1.075).r,
                      readBackdrop(uv+shift).g,readBackdrop(uv+shift*.925).b);
 body=mix(body,dispersion,edge*.85);
 // Schlick Fresnel, specular key light and opposite rim reflection.
 float fresnel=.035+.965*pow(1.-normal.z,5.);
 vec2 light=normalize(uLight);
 float spec=pow(max(0.,dot(outward,light)),10.)*pow(edge,7.);
 float opposite=pow(max(0.,dot(outward,-light)),8.)*pow(edge,10.);
 float rim=exp(-abs(d+1.1)*1.8);
 vec3 reflection=readBackdrop(uv-shift*1.7);
 body=mix(body,reflection,min(.34,fresnel*.5));
 body=mix(body,mix(vec3(1.),vec3(.12,.15,.17),uDark),mix(.025,.045,uDark));
 body+=vec3(1.)*spec*mix(.18,.14,uDark)+vec3(.18)*opposite*.18;
 body+=vec3(rim*mix(.022,.035,uDark));
 gl_FragColor=vec4(body,coverage);
}`;

const SELECTORS = '.app-nav,#theme-toggle,.library-entry-actions>button,.deduct-button';
const KEY = Symbol.for('doudang.liquidGlass');

export function installLiquidGlass() {
    if (window[KEY]) return window[KEY];
    const root = document.documentElement;
    if (!window.WebGLRenderingContext) { root.dataset.liquidGlass = 'fallback'; return null; }
    const canvas = document.createElement('canvas');
    canvas.className = 'qisao-optical-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    if (!gl) { root.dataset.liquidGlass = 'fallback'; return null; }
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
    const forcedColors = matchMedia('(forced-colors: active)');
    const objects = [];
    function program(fragment) {
        const shaders = [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
            const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Glass shader unavailable'); }
            objects.push(['shader', shader]); return shader;
        });
        const p = gl.createProgram(); shaders.forEach(s => gl.attachShader(p, s)); gl.linkProgram(p);
        objects.push(['program', p]);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Glass program unavailable');
        const names = ['uResolution','uViewport','uTime','uDark','uBackdrop','uRect','uRadius','uLens','uLight','uRefraction','uSource','uCorner'];
        return { value: p, position: gl.getAttribLocation(p, 'aPosition'), uniforms: Object.fromEntries(names.map(n => [n,gl.getUniformLocation(p,n)])) };
    }
    let scene, optics;
    try { scene = program(SCENE); optics = program(OPTICS); }
    catch { root.dataset.liquidGlass = 'fallback'; release(); return null; }
    const vertices = gl.createBuffer(); objects.push(['buffer',vertices]);
    gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const texture = gl.createTexture(); objects.push(['texture',texture]);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    const sourceTexture=gl.createTexture();objects.push(['texture',sourceTexture]);
    const sourceCanvas=document.createElement('canvas');
    const sourceContext=sourceCanvas.getContext('2d',{alpha:false});
    const framebuffer=gl.createFramebuffer(); objects.push(['framebuffer',framebuffer]);
    const presentation=document.createElement('canvas');
    presentation.className='qisao-optical-backdrop';
    presentation.setAttribute('aria-hidden','true');
    document.body.prepend(presentation,canvas);
    let width=0,height=0,raf=0,lastFrame=-Infinity,dirty=true,targets=[],paused=false,lost=false;
    let frames=0,drawMilliseconds=0,visibleLenses=0,failure="";
    let light=[-.65,-.76];
    const disposers=[];
    const sizeObserver=new ResizeObserver(()=>invalidate());
    let observed=new Set();
    const layers=new Map();
    const on=(target,event,callback,options)=>{target.addEventListener(event,callback,options);disposers.push(()=>target.removeEventListener(event,callback,options));};
    function use(p) {
        gl.useProgram(p.value); gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
        gl.enableVertexAttribArray(p.position);gl.vertexAttribPointer(p.position,2,gl.FLOAT,false,0,0);
        gl.uniform2f(p.uniforms.uResolution,canvas.width,canvas.height);
        gl.uniform1f(p.uniforms.uDark,getComputedStyle(root).colorScheme.includes('dark')?1:0);
    }
    function resize() {
        width=innerWidth; height=innerHeight;
        const ratio=Math.min(devicePixelRatio||1,1.5,Math.sqrt(1400000/(width*height)));
        const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
        if(canvas.width===w && canvas.height===h)return;
        canvas.width=w;canvas.height=h;
        presentation.width=w;presentation.height=h;
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Glass texture unavailable');
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    function scan() {
        targets=[...document.querySelectorAll(SELECTORS)];
        const next=new Set(targets);
        for(const el of observed)if(!next.has(el)){sizeObserver.unobserve(el);layers.get(el)?.remove();layers.delete(el);}
        for(const el of targets){
            if(!el.classList.contains('qg-surface'))el.classList.add('qg-surface');
            if(getComputedStyle(el).position==='static')el.classList.add('qg-positioned');
            if(!observed.has(el))sizeObserver.observe(el);
        }
        observed=next;
        dirty=false;
    }
    // Known app surfaces and same-origin photos form the scene texture.
    // No arbitrary DOM-pixel or operating-system window capture is used.
    function drawSource(){
        if(sourceCanvas.width!==canvas.width||sourceCanvas.height!==canvas.height){sourceCanvas.width=canvas.width;sourceCanvas.height=canvas.height;}
        const ctx=sourceContext,sx=canvas.width/width,sy=canvas.height/height;
        ctx.setTransform(sx,0,0,sy,0,0);
        const rootStyle=getComputedStyle(root),token=name=>rootStyle.getPropertyValue(name).trim();
        ctx.fillStyle=token('--bg');ctx.fillRect(0,0,width,height);
        const dialog=document.querySelector('dialog[open]');
        for(const card of document.querySelectorAll('.bean-card')){
            if(dialog||!card.getClientRects().length||card.closest('[hidden]'))continue;
            const r=card.getBoundingClientRect();if(r.bottom<0||r.top>height)continue;
            const fill=ctx.createLinearGradient(0,r.top,0,r.bottom);
            fill.addColorStop(0,token('--material-card-top'));fill.addColorStop(1,token('--material-card-bottom'));
            ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(r.x,r.y,r.width,r.height,28);ctx.fill();
            const cover=card.querySelector('.bean-cover');if(!cover)continue;
            const c=cover.getBoundingClientRect();ctx.save();ctx.beginPath();ctx.roundRect(c.x,c.y,c.width,c.height,16);ctx.clip();
            ctx.fillStyle=token('--cover');ctx.fillRect(c.x,c.y,c.width,c.height);
            const image=cover.querySelector('img');
            if(image?.complete&&image.naturalWidth){
                const url=new URL(image.currentSrc||image.src,location.href);
                if(url.origin===location.origin||url.protocol==='data:'||url.protocol==='blob:'){
                    const fit=Math.min(c.width/image.naturalWidth,c.height/image.naturalHeight),w=image.naturalWidth*fit,h=image.naturalHeight*fit;
                    ctx.drawImage(image,c.x+(c.width-w)/2,c.y+(c.height-h)/2,w,h);
                }
            }
            ctx.restore();
        }
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,sourceTexture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sourceCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.activeTexture(gl.TEXTURE0);
    }
    function paint(time=0,enabled=true,strength=1) {
        const start=performance.now();
        if(lost)return;
        const accessible=forcedColors.matches||reducedTransparency.matches;
        root.dataset.liquidGlass=accessible?'fallback':'webgl';
        canvas.hidden=accessible;
        presentation.hidden=accessible;
        if(accessible)return;
        resize(); if(dirty)scan(); drawSource();
        gl.viewport(0,0,canvas.width,canvas.height);
        gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
        use(scene);gl.uniform1i(scene.uniforms.uSource,1);
        gl.drawArrays(gl.TRIANGLES,0,3);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        use(optics);gl.uniform1i(optics.uniforms.uBackdrop,0);
        gl.uniform2f(optics.uniforms.uViewport,width,height);
        gl.uniform2fv(optics.uniforms.uLight,light);
        gl.uniform1f(optics.uniforms.uRefraction,strength);
        gl.uniform1f(optics.uniforms.uLens,0);
        gl.drawArrays(gl.TRIANGLES,0,3);
        presentation.getContext('2d',{alpha:false}).drawImage(canvas,0,0);
        visibleLenses=0;
        const drawn=[];
        if(enabled){
            gl.uniform1f(optics.uniforms.uLens,1);
            gl.enable(gl.SCISSOR_TEST); gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
            const dialog=document.querySelector('dialog[open]');
            for(const el of targets){
                if(!el.isConnected||el.closest('[hidden], [inert]')||(dialog&&!dialog.contains(el)&&el!==dialog))continue;
                const r=el.getBoundingClientRect();
                if(r.width<16||r.height<16||r.right<=0||r.bottom<=0||r.left>=width||r.top>=height)continue;
                const style=getComputedStyle(el);
                if(style.visibility==='hidden'||style.display==='none')continue;
                let left=Math.max(0,r.left),right=Math.min(width,r.right),top=Math.max(0,r.top),bottom=Math.min(height,r.bottom);
                // Respect scroll-container clipping; prevents offscreen form lenses leaking.
                for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement){
                    const s=getComputedStyle(p);
                    if(/auto|scroll|hidden|clip/.test(s.overflowX+' '+s.overflowY)){
                        const c=p.getBoundingClientRect();left=Math.max(left,c.left);right=Math.min(right,c.right);top=Math.max(top,c.top);bottom=Math.min(bottom,c.bottom);
                    }
                }
                if(right<=left||bottom<=top)continue;
                const sx=canvas.width/width,sy=canvas.height/height;
                const x=Math.max(0,Math.floor(left*sx)),y=Math.max(0,Math.floor((height-bottom)*sy));
                gl.scissor(x,y,Math.min(canvas.width-x,Math.ceil((right-left)*sx)),Math.min(canvas.height-y,Math.ceil((bottom-top)*sy)));
                const radius=parseFloat(style.getPropertyValue('--smooth-radius'))||parseFloat(style.borderTopLeftRadius)||20;
                gl.uniform4f(optics.uniforms.uRect,r.left,r.top,r.width,r.height);
                gl.uniform1f(optics.uniforms.uCorner,Number(style.getPropertyValue('corner-shape').match(/superellipse\(([\d.]+)\)/)?.[1])||1);
                gl.uniform1f(optics.uniforms.uRadius,style.borderTopLeftRadius.endsWith('%')?Math.min(r.width,r.height)*radius/100:radius);
                gl.drawArrays(gl.TRIANGLES,0,3);visibleLenses++;
                drawn.push({el,r});
                if(visibleLenses>=24)break;
            }
            gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);
        }
        // Composite the SAME GPU-rendered background inside each surface. This
        // keeps top-layer dialogs opaque to underlying DOM text, and avoids the
        // WebKit cleared-default-framebuffer issue when the background is still.
        // These are 2D copies, not additional WebGL contexts or DOM screenshots.
        for(const {el,r} of drawn){
            let layer=layers.get(el);
            if(!layer){layer=document.createElement('canvas');layer.className='qisao-optical-surface';layer.setAttribute('aria-hidden','true');layers.set(el,layer);}
            if(layer.parentElement!==el)el.prepend(layer);
            const sx=canvas.width/width,sy=canvas.height/height;
            const w=Math.max(1,Math.round(r.width*sx)),h=Math.max(1,Math.round(r.height*sy));
            if(layer.width!==w||layer.height!==h){layer.width=w;layer.height=h;}
            const ctx=layer.getContext('2d',{alpha:false});
            ctx.drawImage(canvas,r.left*sx,r.top*sy,r.width*sx,r.height*sy,0,0,w,h);
        }
        frames++;drawMilliseconds=performance.now()-start;
    }
    function schedule(){if(!raf&&!paused&&!lost&&!document.hidden)raf=requestAnimationFrame(frame);}
    function frame(now){
        raf=0;
        if(now-lastFrame>=(width<720?50:33)){
            lastFrame=now;
            try{paint(now/1000);}catch(error){failure=error.message;lost=true;root.dataset.liquidGlass='fallback';canvas.hidden=true;presentation.hidden=true;return;}
        }
        // Solid backgrounds redraw only for layout, theme and light changes.
    }
    function invalidate(){dirty=true;lastFrame=-Infinity;schedule();}
    const observer=new MutationObserver(records=>{
        // Do not observe our class/data writes: no per-frame observer feedback loop.
        if(records.some(r=>{
            if(r.type==='childList'){
                return [...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&n!==canvas&&!n.classList.contains('qisao-optical-surface'));
            }
            if(r.target===canvas||r.target===presentation)return false;
            if(r.attributeName==='class')return (r.oldValue||'').replace(/\bqg-(?:surface|positioned)\b/g,'').trim()!==(r.target.getAttribute('class')||'').replace(/\bqg-(?:surface|positioned)\b/g,'').trim();
            return true;
        }))invalidate();
    });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['hidden','open','class']});
    const themeObserver=new MutationObserver(invalidate);
    themeObserver.observe(root,{attributes:true,attributeFilter:['data-theme','class','style']});
    on(window,'resize',invalidate,{passive:true});on(document,'scroll',invalidate,{passive:true,capture:true});
    if(window.visualViewport){on(window.visualViewport,'resize',invalidate,{passive:true});on(window.visualViewport,'scroll',invalidate,{passive:true});}
    on(document,'load',invalidate,true);on(document,'toggle',invalidate,true);on(document,'transitionend',invalidate,true);
    on(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else invalidate();});
    on(window,'pointermove',event=>{
        if(reducedMotion.matches)return;
        light=[(event.clientX/Math.max(width,1)-.5)*1.6,-.8+(event.clientY/Math.max(height,1))*.4];
        schedule();
    },{passive:true});
    for(const pref of [reducedMotion,reducedTransparency,forcedColors,matchMedia('(prefers-color-scheme: dark)')])on(pref,'change',invalidate);
    on(canvas,'webglcontextlost',event=>{event.preventDefault();lost=true;cancelAnimationFrame(raf);raf=0;root.dataset.liquidGlass='fallback';canvas.hidden=true;presentation.hidden=true;});
    on(canvas,'webglcontextrestored',()=>{api.destroy();installLiquidGlass();});
    function release(){
        for(const [type,obj] of objects)gl['delete'+type[0].toUpperCase()+type.slice(1)](obj);
    }
    const api={
        inspect:()=>({renderer:'webgl-bean-scene-refraction',frames,lenses:visibleLenses,drawMilliseconds,failure,pixels:canvas.width*canvas.height,glError:gl.getError(),mode:root.dataset.liquidGlass}),
        // Deterministic, read-only rendering aid for optical pixel verification.
        renderStill(time=0,opticsEnabled=true,strength=1){paused=true;cancelAnimationFrame(raf);raf=0;paint(time,opticsEnabled,strength);},
        resume(){paused=false;invalidate();},
        destroy(){paused=true;cancelAnimationFrame(raf);observer.disconnect();themeObserver.disconnect();sizeObserver.disconnect();disposers.forEach(fn=>fn());release();canvas.remove();presentation.remove();layers.forEach(layer=>layer.remove());layers.clear();targets.forEach(el=>el.classList.remove('qg-surface','qg-positioned'));delete root.dataset.liquidGlass;delete window[KEY];},
    };
    window[KEY]=api;
    schedule();
    return api;
}
