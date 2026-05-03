pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  environment {
    DOCKER_IMAGE = 'alskung/biddinggo-frontend'
    DOCKERHUB_CREDENTIALS_ID = 'dockerhub-credentials'
    GITHUB_CREDENTIALS_ID = 'github-credentials'
    K8S_DEPLOYMENT_MANIFEST = 'k8s/frontend-deployment.yaml'
    VITE_API_BASE_URL = '/api/v1'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          env.GIT_COMMIT_SHORT = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_COMMIT_SHORT}"
          env.LAST_COMMIT_MESSAGE = sh(script: 'git log -1 --pretty=%B', returnStdout: true).trim()
        }
      }
    }

    stage('Skip CI Commit') {
      when {
        expression { env.LAST_COMMIT_MESSAGE.contains('[skip ci]') }
      }
      steps {
        echo 'Skipping manifest-only CI commit.'
      }
    }

    stage('Install') {
      when {
        expression { !env.LAST_COMMIT_MESSAGE.contains('[skip ci]') }
      }
      steps {
        sh 'npm ci'
      }
    }

    stage('Build') {
      when {
        expression { !env.LAST_COMMIT_MESSAGE.contains('[skip ci]') }
      }
      steps {
        sh 'npm run build'
      }
    }

    stage('Docker Build and Push') {
      when {
        expression { !env.LAST_COMMIT_MESSAGE.contains('[skip ci]') }
      }
      steps {
        script {
          docker.withRegistry('https://index.docker.io/v1/', env.DOCKERHUB_CREDENTIALS_ID) {
            def app = docker.build(
              "${env.DOCKER_IMAGE}:${env.IMAGE_TAG}",
              "--build-arg VITE_API_BASE_URL=${env.VITE_API_BASE_URL} ."
            )
            app.push()
            app.push('latest')
          }
        }
      }
    }

    stage('Update Kubernetes Manifest') {
      when {
        expression { !env.LAST_COMMIT_MESSAGE.contains('[skip ci]') }
      }
      steps {
        withCredentials([usernamePassword(
          credentialsId: env.GITHUB_CREDENTIALS_ID,
          usernameVariable: 'GIT_USERNAME',
          passwordVariable: 'GIT_PASSWORD'
        )]) {
          sh '''
            set -eu
            sed -i "s#image: alskung/biddinggo-frontend:.*#image: alskung/biddinggo-frontend:${IMAGE_TAG}#" "${K8S_DEPLOYMENT_MANIFEST}"
            git config user.name "jenkins"
            git config user.email "jenkins@local"
            git add "${K8S_DEPLOYMENT_MANIFEST}"
            if git diff --cached --quiet; then
              echo "No manifest change to commit."
              exit 0
            fi
            git commit -m "ci: deploy frontend ${IMAGE_TAG} [skip ci]"
            git push "https://${GIT_USERNAME}:${GIT_PASSWORD}@${GIT_URL#https://}" HEAD:${BRANCH_NAME}
          '''
        }
      }
    }
  }

  post {
    success {
      echo 'Frontend image pushed and Kubernetes manifest updated. Argo CD will deploy from the GitOps change.'
    }
  }
}
