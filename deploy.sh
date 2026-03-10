#!/bin/bash
# deploy.sh - Automated deployment to Vercel
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Starting deployment process..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "script.js" ]; then
    echo -e "${YELLOW}⚠️  Not in project directory. Changing to project root...${NC}"
    cd "/Users/leandrocarbone/Google Drive/Proyectos Visual Studio/Flight Tracker"
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes:${NC}"
    git status --short
    echo ""
    read -p "Commit and push these changes? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}📝 Committing changes...${NC}"
        git add -A
        read -p "Commit message: " commit_msg
        git commit -m "$commit_msg"
        echo -e "${BLUE}⬆️  Pushing to GitHub...${NC}"
        git push origin main
        echo ""
    else
        echo -e "${YELLOW}⚠️  Deployment cancelled. Commit your changes first.${NC}"
        exit 1
    fi
fi

# Deploy to Vercel
echo -e "${BLUE}🔄 Pulling latest changes to temp directory...${NC}"
cd /tmp
rm -rf flight-tracker-deploy
git clone https://github.com/lele32/Flight-Tracker.git flight-tracker-deploy 2>&1 | grep -E "(Cloning|done)"
cd flight-tracker-deploy

echo ""
echo -e "${BLUE}🚀 Deploying to Vercel Production...${NC}"
npx vercel --prod --yes

echo ""
echo -e "${GREEN}✅ Deployment completed!${NC}"
echo ""
echo -e "${BLUE}🔗 Production URL:${NC} https://flight-tracker-deploy.vercel.app"
echo -e "${BLUE}🧪 Test API:${NC} curl https://flight-tracker-deploy.vercel.app/api/lookupFlight?flightNumber=AR1388"
echo ""
echo -e "${GREEN}🎉 All done!${NC}"
