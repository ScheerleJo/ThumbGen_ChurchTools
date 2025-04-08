const canvas = require('canvas');
const fs = require('fs');

function initializeCanvas() {
    const thumbnail = canvas.createCanvas(1920, 1080);
    canvas.deregisterAllFonts();
    canvas.registerFont('assets/Ubuntu-Bold.ttf', { family: 'Ubuntu Bold' })
    return thumbnail;
}

function loadImage(thumbnail, imagePath){
    const ctx = thumbnail.getContext('2d')

    const img = new canvas.Image()
    img.onload = () => ctx.drawImage(img, 0, 0)
    img.onerror = err => { throw err }
    img.src = imagePath
    ctx.drawImage(img, 0, 0)
}

function writeTextOnCanvas(thumbnail, textInfo) {
    const ctx = thumbnail.getContext('2d');
    
    //Drop Shadow Settings
    ctx.shadowColor = "rgba(30, 30, 30, 0.5)";
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 10;
    ctx.shadowBlur = 15;

    ctx.font = '80pt Ubuntu Bold'; //Header Style
    ctx.fillStyle = '#d621a5' //Pink
    ctx.fillText(textInfo.date, 127, 220);
    ctx.fillStyle = '#ffcc00' //Yellow
    ctx.fillText(textInfo.event.toUpperCase(), 127, 350);

    ctx.font = '75pt Ubuntu Bold'; //Subject Style
    ctx.fillStyle = '#ffffff' //White
    ctx.fillText(textInfo.subject, 140, 750);
    // ctx.fillText(subject, 140, 870); // second line
}

function exportImage(thumbnail, date){
    thumbnail.createJPEGStream().pipe(fs.createWriteStream(`thumbnail ${date}.jpeg`)).on('finish', () => {
        console.log('Thumbnail created!');
    });
}

function selectBackground(event) {
    let backgrounds = fs.readdirSync('./assets/backgrounds/')

    if (backgrounds.includes(event.toLowerCase() + '.png'))
        return event.toLowerCase() + '.png';
    else 
        return 'default.png';
}

function create(thumbnailInfo) {
    let thumbnail = initializeCanvas()
    loadImage(thumbnail, 'assets/backgrounds/' + selectBackground(thumbnailInfo.event)); //Load background image
    loadImage(thumbnail, 'assets/logo.png'); //Load logo image
    writeTextOnCanvas(thumbnail, thumbnailInfo); //Write text on canvas
    exportImage(thumbnail, thumbnailInfo.date);
}

module.exports = {create}